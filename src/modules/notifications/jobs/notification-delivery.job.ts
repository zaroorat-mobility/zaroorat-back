import { logger } from '@shared/logger/index.js';
import type {
  NotificationRepository,
  PushDeliveryWithDevice,
} from '../repositories/notification.repository.js';
import type { DeviceRepository } from '@modules/auth/repositories/device.repository.js';
import {
  PAYLOAD_TOO_LARGE,
  type PushProvider,
  type PushSendResult,
} from '../providers/push.provider.js';
import {
  resolveCollapseKey,
  resolveDeliveryPresentation,
  resolveNotificationPriority,
  resolveOfferWindow,
  type NotificationDeliveryClass,
} from '../policies/notification-priority.policy.js';
import { notificationNoActiveDevice } from '../metrics/notification.metrics.js';

export interface NotificationDeliveryJobData {
  notificationId: string;
  /// The delivery the consumer created with the notification. Since multi-device
  /// delivery the job works from `notificationId` and this is only carried for
  /// tracing; jobs already queued before that change still run unchanged.
  deliveryId: string;
  /// Correlation context, supplied by the producing consumer so this worker can
  /// log the same identifiers without a second query. All optional: a job that
  /// was already sitting in Redis when this deployed carries only the two ids,
  /// and must still run.
  eventId?: string;
  eventType?: string;
  userId?: string;
  rideId?: string | null;
  category?: string;
}

const DELIVERY_CLASSES: readonly NotificationDeliveryClass[] = [
  'CRITICAL',
  'RIDE_OFFER',
  'TRANSACTIONAL',
  'GENERAL',
  'PROMOTIONAL',
];

export function isDeliveryClass(value: unknown): value is NotificationDeliveryClass {
  return typeof value === 'string' && (DELIVERY_CLASSES as readonly string[]).includes(value);
}

/// FCM accepts string values only. `Notification.data` is a Prisma `Json` column,
/// so nothing at the type level stops a future writer putting a number or a
/// nested object in it — and FCM would reject the whole message as
/// `invalid-argument`, which this pipeline deliberately treats as retryable. So a
/// single bad value would burn the retry budget and then drop the notification.
///
/// Dropping the offending key and logging it loudly is the lesser harm: the
/// notification still arrives, missing one field, and the log says which.
function coerceStringData(
  raw: unknown,
  trace: Record<string, unknown>,
): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const out: Record<string, string> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value;
    } else {
      dropped.push(`${key}:${value === null ? 'null' : typeof value}`);
    }
  }

  if (dropped.length > 0) {
    logger.error(
      { ...trace, dropped },
      '[NotificationWorker] non-string values in notification data were dropped; FCM accepts strings only',
    );
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export interface NotificationDeliveryJobResult {
  delivered: boolean;
  provider?: string | undefined;
  providerRef?: string | null | undefined;
  error?: string | undefined;
}

const DEFINITIVE_INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/// How long a worker may hold one delivery while it calls the provider.
///
/// Aligned with BullMQ's `lockDuration` (30s, the library default this worker
/// uses): by the time BullMQ treats a crashed worker's job as stalled and re-runs
/// it, that worker's delivery lease has expired or is about to. At 60s the lease
/// could outlive the whole retry sequence — a stalled re-run at the early edge of
/// BullMQ's stall window, then the 5s / 10s / 20s backoff, all inside the lease —
/// and the delivery was failed by retry exhaustion without ever being reclaimed.
///
/// Exported so the PostgreSQL suite claims with exactly this value.
export const SEND_LEASE_SECONDS = 30;

const TERMINAL = new Set(['SENT', 'DELIVERED', 'FAILED', 'READ']);

type DeviceOutcome =
  | { kind: 'sent'; result: PushSendResult }
  | { kind: 'failed'; error: string }
  | { kind: 'transient'; error: string }
  /// Still QUEUED, but another attempt holds the lease: retryable.
  | { kind: 'busy' }
  /// Finished by another attempt between the plan and the claim: nothing to do.
  | { kind: 'skipped' };

/// Sends one notification to every eligible device of its user, each tracked on
/// its own delivery row.
///
///   Notification → eligible devices → one delivery per device → send each →
///   independent SENT / FAILED per device → notification SENT if any device got it.
///
/// Every state change is a short, conditional write; the provider call is never
/// inside a transaction. A transient failure on any device throws, so BullMQ
/// retries the job — and the retry sends only to the devices still QUEUED.
export class NotificationDeliveryJob {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly pushProvider: PushProvider,
  ) {}

  /// `clock` exists for tests; production always uses the wall clock.
  async run(
    data: NotificationDeliveryJobData,
    clock: () => number = Date.now,
  ): Promise<NotificationDeliveryJobResult> {
    const { notificationId } = data;
    // Carried through every log line below, so one notification can be followed
    // from the consumer that created it to the provider call. Fields the producer
    // did not supply are simply absent rather than logged as undefined.
    const trace: Record<string, unknown> = {
      notificationId,
      deliveryId: data.deliveryId,
      ...(data.eventId ? { eventId: data.eventId } : {}),
      ...(data.eventType ? { eventType: data.eventType } : {}),
      ...(data.userId ? { userId: data.userId } : {}),
      ...(data.rideId ? { rideId: data.rideId } : {}),
      ...(data.category ? { category: data.category } : {}),
    };

    const notification = await this.notificationRepository.findNotificationById(notificationId);
    if (!notification) {
      logger.error(trace, '[NotificationWorker] Notification record not found');
      return { delivered: false, error: 'RECORD_NOT_FOUND' };
    }

    const devices = await this.deviceRepository.findDeliverableDevices(notification.userId);
    const deliveries = await this.notificationRepository.planDeviceDeliveries(
      notificationId,
      devices.map((device) => device.id),
    );
    if (deliveries.length === 0) {
      logger.error(trace, '[NotificationWorker] Notification has no push delivery record');
      return { delivered: false, error: 'RECORD_NOT_FOUND' };
    }

    const queued = deliveries.filter((delivery) => !TERMINAL.has(delivery.status));
    if (queued.length === 0) {
      // Terminal-state protection: a redelivered or retried job for work that
      // is already finished sends nothing and writes nothing.
      logger.info(
        trace,
        '[NotificationWorker] Skipping notification whose deliveries are terminal',
      );
      return { delivered: deliveries.some((d) => d.status === 'SENT' || d.status === 'DELIVERED') };
    }

    // No device could be bound: the user has nothing to send to.
    if (!deliveries.some((delivery) => delivery.deviceId !== null)) {
      // Counted, not just logged. A rising rate here is the earliest signal that
      // tokens are not arriving or are being cleared faster than registered.
      notificationNoActiveDevice({
        ...(data.eventType ? { event_type: data.eventType } : {}),
        ...(data.category ? { category: data.category } : {}),
      });
      logger.warn(
        { ...trace, userId: notification.userId },
        '[NotificationWorker] User has no active device with an FCM token',
      );
      for (const delivery of queued) {
        await this.notificationRepository.finalizeDelivery(delivery.id, {
          status: 'FAILED',
          errorCode: 'NO_ACTIVE_DEVICE',
          failureReason: 'User has no active device with a valid FCM push token',
          attempts: delivery.attempts + 1,
        });
      }
      await this.notificationRepository.settleNotification(notificationId);
      return { delivered: false, error: 'NO_ACTIVE_DEVICE' };
    }

    // Validated, not cast. The previous `as Record<string, string>` was an
    // unchecked assertion over a Prisma Json column.
    const storedData = coerceStringData(notification.data, trace) ?? {};

    // Presentation follows the delivery class. Taken from the payload the
    // producer stamped; falling back to the event key keeps jobs enqueued before
    // that existed working, and an unrecognised value degrades to TRANSACTIONAL
    // rather than failing the send.
    const deliveryClass: NotificationDeliveryClass = isDeliveryClass(storedData.category)
      ? storedData.category
      : resolveNotificationPriority(notification.eventKey).deliveryClass;
    const presentation = resolveDeliveryPresentation(deliveryClass);
    const collapseKey = resolveCollapseKey(deliveryClass, notification.eventKey ?? '', {
      rideId: storedData.rideId,
      dispatchId: storedData.dispatchId,
    });

    const message = {
      title: notification.title ?? '',
      body: notification.body ?? '',
      storedData,
      deliveryClass,
      channelId: presentation.channelId,
      classTtlMs: presentation.ttlMs,
      collapseKey,
    };

    let sent: PushSendResult | undefined;
    let transientError: string | undefined;
    let permanentError: string | undefined;
    let leaseHeldElsewhere = false;

    try {
      for (const delivery of queued) {
        const outcome = await this.deliverToDevice(delivery, notificationId, message, trace, clock);
        if (outcome.kind === 'sent') sent ??= outcome.result;
        else if (outcome.kind === 'transient') transientError ??= outcome.error;
        else if (outcome.kind === 'failed') permanentError = outcome.error;
        else if (outcome.kind === 'busy') leaseHeldElsewhere = true;
      }
    } finally {
      // Also when a provider exception is on its way to BullMQ, so a device sent
      // to earlier in this run is reflected in the notification's status.
      await this.notificationRepository.settleNotification(notificationId);
    }

    if (transientError) {
      // Throw to trigger BullMQ's retry. Devices already SENT or FAILED are
      // terminal and are not sent to again on the retry.
      throw new Error(
        `Transient FCM push failure [${transientError}] for notification ${notificationId}`,
      );
    }
    if (leaseHeldElsewhere) {
      // Retryable, never success: completing the job here is what stranded a
      // delivery whose lease outlived a crashed worker. The retry claims it once
      // the lease is released or expires, or skips it if the holder finished it.
      throw new Error(
        `Delivery lease held by another attempt for notification ${notificationId}; retrying`,
      );
    }

    if (sent) {
      return { delivered: true, provider: sent.provider, providerRef: sent.providerRef ?? null };
    }
    return { delivered: false, ...(permanentError ? { error: permanentError } : {}) };
  }

  private async deliverToDevice(
    delivery: PushDeliveryWithDevice,
    notificationId: string,
    message: {
      title: string;
      body: string;
      storedData: Record<string, string>;
      deliveryClass: NotificationDeliveryClass;
      channelId: string;
      classTtlMs: number;
      collapseKey: string | null;
    },
    trace: Record<string, unknown>,
    clock: () => number,
  ): Promise<DeviceOutcome> {
    const deviceTrace = { ...trace, deliveryId: delivery.id, deviceId: delivery.deviceId };
    const fail = async (errorCode: string, failureReason: string, provider?: string) => {
      await this.notificationRepository.finalizeDelivery(delivery.id, {
        status: 'FAILED',
        errorCode,
        failureReason,
        ...(provider ? { provider } : {}),
      });
      return { kind: 'failed' as const, error: errorCode };
    };

    // The device may have logged out, been revoked, or been deleted since the
    // plan — its current state decides, not the state when it was planned.
    const device = delivery.device;
    if (!device || !device.fcmToken || device.trustState === 'REVOKED') {
      logger.info(deviceTrace, '[NotificationWorker] Device no longer deliverable; skipped');
      return fail('DEVICE_INELIGIBLE', 'Device no longer holds a deliverable push token');
    }

    // A ride offer lives exactly as long as the offer, measured now — on every
    // attempt, so a retry that lands after the window closed sends nothing.
    let ttlMs = message.classTtlMs;
    let expiresAt: Date | undefined;
    if (message.deliveryClass === 'RIDE_OFFER') {
      const window = resolveOfferWindow(message.storedData.expiresAt, clock());
      if (window?.expired) {
        logger.info(deviceTrace, '[NotificationWorker] Ride offer expired before send; not sent');
        return fail('OFFER_EXPIRED', 'Ride offer expired before it could be sent');
      }
      if (window) {
        ttlMs = window.ttlMs;
        expiresAt = window.expiresAt;
      }
    }

    const attempt = await this.notificationRepository.claimDelivery(
      delivery.id,
      SEND_LEASE_SECONDS,
    );
    if (attempt === null) {
      // Either another attempt finished it since the plan was read — nothing to
      // do — or a lease is still held on it. The second is the case that matters:
      // a worker that crashed after claiming leaves its lease behind, and BullMQ's
      // stalled re-run arrives while it is still live. Treating that as done
      // completed the job and stranded the delivery QUEUED for good; it has to be
      // retried until the lease is released or expires.
      const current = await this.notificationRepository.findDeliveryById(delivery.id);
      if (current?.status !== 'QUEUED') {
        logger.info(deviceTrace, '[NotificationWorker] Delivery finished elsewhere; skipped');
        return { kind: 'skipped' };
      }
      logger.warn(
        deviceTrace,
        '[NotificationWorker] Delivery lease held by another attempt; will retry',
      );
      return { kind: 'busy' };
    }

    // `notificationId` and `deliveryId` are only knowable once the rows exist, so
    // they are merged here rather than written into the stored payload. Merged
    // last so a stored value can never shadow the real ids.
    let result: PushSendResult;
    try {
      result = await this.pushProvider.sendPush({
        to: device.fcmToken,
        title: message.title,
        body: message.body,
        data: { ...message.storedData, notificationId, deliveryId: delivery.id },
        channelId: message.channelId,
        ttlMs,
        ...(expiresAt ? { expiresAt } : {}),
        ...(message.collapseKey ? { collapseKey: message.collapseKey } : {}),
      });
    } catch (err) {
      // The provider threw instead of returning a result. Our lease would
      // otherwise sit on the delivery until it expired, and every retry inside
      // that window would find it busy. Release it — only if it is still ours —
      // keep the delivery QUEUED, and let the exception reach BullMQ.
      await this.notificationRepository
        .releaseDelivery(
          delivery.id,
          attempt,
          'PROVIDER_EXCEPTION',
          `Push attempt ${attempt} threw: ${err instanceof Error ? err.message : String(err)}`,
        )
        .catch((releaseErr: unknown) =>
          logger.error(
            { ...deviceTrace, err: releaseErr },
            '[NotificationWorker] Failed to release the delivery lease after a provider exception',
          ),
        );
      throw err;
    }

    if (result.accepted) {
      logger.info(
        { ...deviceTrace, providerRef: result.providerRef, channelId: message.channelId, attempt },
        '[NotificationWorker] Push delivered successfully',
      );
      await this.notificationRepository.finalizeDelivery(delivery.id, {
        status: 'SENT',
        provider: result.provider,
        providerMessageId: result.providerRef ?? null,
        sentAt: new Date(clock()),
      });
      return { kind: 'sent', result };
    }

    const errorCode = result.error ?? 'UNKNOWN_FCM_ERROR';
    // An invalid token was already cleared from the device registry by the
    // provider. A payload over the transport's limit cannot be fixed by sending
    // it again. Both fail once, without consuming the retry budget.
    if (DEFINITIVE_INVALID_TOKEN_CODES.has(errorCode)) {
      logger.warn(
        { ...deviceTrace, errorCode },
        '[NotificationWorker] Permanent FCM invalid token error — marking failed',
      );
      return fail(errorCode, 'FCM token permanently dead or invalid', result.provider);
    }
    if (errorCode === PAYLOAD_TOO_LARGE) {
      logger.warn(
        { ...deviceTrace, errorCode },
        '[NotificationWorker] Payload over transport limit — marking failed without retry',
      );
      return fail(
        errorCode,
        'Notification data payload exceeded the transport limit',
        result.provider,
      );
    }

    await this.notificationRepository.releaseDelivery(
      delivery.id,
      attempt,
      errorCode,
      `FCM push attempt ${attempt} failed: ${errorCode}`,
    );
    return { kind: 'transient', error: errorCode };
  }

  /// Retries are exhausted. Every device still QUEUED fails; a device that was
  /// already sent to keeps its SENT, and so does the notification.
  async markExhausted(notificationId: string, reason: string): Promise<void> {
    try {
      await this.notificationRepository.failQueuedDeliveries(
        notificationId,
        `Exhausted retries: ${reason}`,
      );
      await this.notificationRepository.settleNotification(notificationId);
      logger.warn(
        { notificationId, reason },
        '[NotificationWorker] Marked notification as exhausted',
      );
    } catch (err) {
      logger.error(
        { err, notificationId },
        '[NotificationWorker] Failed to mark notification as exhausted',
      );
    }
  }
}
