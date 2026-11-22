import type { DatabaseService } from '@core/database';
import type { EventBus, EventEnvelope, Unsubscribe } from '@core/events';
import { logger } from '@shared/logger/index.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import type { NotificationService } from '../notification.service.js';
import type { SmsSendResult } from '../providers/sms.provider.js';
import { resolveNotificationPriority } from '../policies/notification-priority.policy.js';
import { writeNotificationPlan } from '@modules/rides/consumers/ride-notification.writer.js';

/// How long one attempt holds the delivery while it calls the provider — the push
/// worker's lease, so a crashed attempt's delivery is reclaimable on the next retry.
const SEND_LEASE_SECONDS = 30;

const DECISION_EVENTS = {
  'driver.verified': 'activated',
  'driver.verification_rejected': 'rejected',
  'driver.resubmission_requested': 'resubmission',
} as const;
type Decision = (typeof DECISION_EVENTS)[keyof typeof DECISION_EVENTS];

/// Fixed text, like the SMS templates: the operator's reason stays in the app.
const DECISION_PUSH: Record<Decision, { title: string; body: string }> = {
  activated: {
    title: 'Application approved',
    body: 'Your Zaroorat driver account is active. Open the app to get started.',
  },
  rejected: {
    title: 'Driver application update',
    body: 'Your driver application was not approved. Open the app for details.',
  },
  resubmission: {
    title: 'Action needed on your application',
    body: 'Some documents need to be uploaded again. Open the app to see what to fix.',
  },
};

/// Texts the driver about an application decision, from the decision's outbox event, and
/// queues a push for their registered device (a driver with none gets the SMS only).
///
/// The event commits with the decision and its audit row, and the relay delivers it only
/// after commit — so a rolled-back decision texts no one, and a crash after commit loses
/// nothing (the relay redelivers). Redelivery is the relay's retry: a retryable provider
/// failure throws here and the relay backs off (bounded, jittered) and tries again.
///
/// At most one SMS per event, as far as this side can make it: the ledger row is keyed by
/// the event id (`Notification.idempotencyKey`), a lease stops two attempts sending at once,
/// and a delivery that is already SENT or FAILED is never sent again. The provider itself
/// gives no exactly-once guarantee: if this process dies after the provider accepted the
/// message but before the delivery is marked SENT, the redelivered event sends it again.
export class DriverDecisionSmsConsumer {
  constructor(
    private readonly eventBus: EventBus,
    private readonly notificationRepository: NotificationRepository,
    private readonly notificationService: NotificationService,
    private readonly databaseService: DatabaseService,
  ) {}

  register(): Unsubscribe {
    const unsubscribes = Object.keys(DECISION_EVENTS).map((type) =>
      this.eventBus.on(type, (envelope) => this.handle(envelope)),
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  private async handle(envelope: EventEnvelope): Promise<void> {
    const decision = DECISION_EVENTS[envelope.type as keyof typeof DECISION_EVENTS];
    const data = envelope.data as { userId?: string; driverId?: string; reason?: string };
    const trace = { eventId: envelope.eventId, type: envelope.type, driverId: data.driverId };
    if (!decision || !data.userId) {
      logger.warn(trace, '[DriverDecisionSms] event carried no userId; nothing to send');
      return;
    }
    // The push rides the same delivery pipeline as ride notifications (ledger row, queued
    // job, reconciliation sweep, FCM). Keyed by the event, so a redelivery writes nothing.
    const priority = resolveNotificationPriority(envelope.type);
    await writeNotificationPlan(
      envelope,
      {
        audience: 'driver',
        deliveryClass: priority.deliveryClass,
        bullMqPriority: priority.bullMqPriority,
        input: {
          userId: data.userId,
          category: 'TRANSACTIONAL',
          priority: priority.prismaPriority,
          eventKey: envelope.type,
          idempotencyKey: `push:${envelope.eventId}`,
          ...DECISION_PUSH[decision],
          data: { type: envelope.type, ...(data.driverId ? { driverId: data.driverId } : {}) },
          referenceType: 'driver',
          referenceId: data.driverId ?? null,
        },
      },
      this.notificationRepository,
    );
    const user = await this.databaseService.client.user.findUnique({
      where: { id: data.userId },
      select: { phoneNumber: true },
    });
    if (!user?.phoneNumber) {
      logger.warn(trace, '[DriverDecisionSms] no phone on record; nothing to send');
      return;
    }

    const { notification, delivery } =
      await this.notificationRepository.createNotificationWithDelivery({
        userId: data.userId,
        category: 'TRANSACTIONAL',
        eventKey: envelope.type,
        idempotencyKey: `sms:${envelope.eventId}`,
        channel: 'SMS',
        recipient: user.phoneNumber,
        referenceType: 'driver',
        referenceId: data.driverId ?? null,
      });
    if (!delivery) return;

    const attempt = await this.notificationRepository.claimDelivery(
      delivery.id,
      SEND_LEASE_SECONDS,
    );
    if (attempt === null) {
      const current = await this.notificationRepository.findDeliveryById(delivery.id);
      // Already SENT or FAILED: this is a redelivery, and the driver was told once.
      if (current && current.status !== 'QUEUED') return;
      // Another attempt holds the lease; let the relay come back after its backoff.
      throw new Error('Driver decision SMS is held by another attempt');
    }

    const result = await this.send(decision, user.phoneNumber, data.reason);
    if (result.accepted) {
      await this.notificationRepository.finalizeDelivery(delivery.id, {
        status: 'SENT',
        provider: result.provider,
        providerMessageId: result.providerRef ?? null,
        sentAt: new Date(),
      });
      await this.notificationRepository.settleNotification(notification.id);
      logger.info({ ...trace, attempt }, '[DriverDecisionSms] sent');
      return;
    }
    if (result.retryable) {
      await this.notificationRepository.releaseDelivery(
        delivery.id,
        attempt,
        'PROVIDER_RETRYABLE',
        result.error ?? 'Provider refused the message',
      );
      throw new Error(`Driver decision SMS not accepted, will retry: ${result.error ?? 'unknown'}`);
    }
    await this.notificationRepository.finalizeDelivery(delivery.id, {
      status: 'FAILED',
      provider: result.provider,
      errorCode: 'PROVIDER_REJECTED',
      errorMessage: result.error ?? null,
      failureReason: result.error ?? 'Provider refused the message permanently',
    });
    await this.notificationRepository.settleNotification(notification.id);
    logger.error({ ...trace, error: result.error }, '[DriverDecisionSms] refused permanently');
  }

  /// Registered DLT templates only. The production templates are fixed text: the operator's
  /// reason reaches the SMS only in the development fallback bodies, never in production.
  private send(decision: Decision, to: string, reason: string | undefined): Promise<SmsSendResult> {
    if (decision === 'activated') return this.notificationService.sendDriverActivatedSms(to);
    if (decision === 'rejected')
      return this.notificationService.sendDriverApplicationRejectedSms(to);
    return this.notificationService.sendDriverDocRejectedSms(
      to,
      'Profile',
      reason ?? 'Please review and re-upload your documents',
    );
  }
}
