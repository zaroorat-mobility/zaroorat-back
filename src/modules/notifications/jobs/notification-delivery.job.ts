import { logger } from '@shared/logger/index.js';
import type { NotificationRepository } from '../repositories/notification.repository.js';
import type { DeviceRepository } from '@modules/auth/repositories/device.repository.js';
import type { PushProvider } from '../providers/push.provider.js';

export interface NotificationDeliveryJobData {
  notificationId: string;
  deliveryId: string;
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

export class NotificationDeliveryJob {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly pushProvider: PushProvider,
  ) {}

  async run(data: NotificationDeliveryJobData): Promise<NotificationDeliveryJobResult> {
    const { notificationId, deliveryId } = data;

    const deliveryRecord = await this.notificationRepository.findDeliveryById(deliveryId);
    if (!deliveryRecord || !deliveryRecord.notification) {
      logger.error(
        { notificationId, deliveryId },
        '[NotificationWorker] Delivery or Notification record not found',
      );
      return { delivered: false, error: 'RECORD_NOT_FOUND' };
    }

    const { notification } = deliveryRecord;

    // Terminal state protection: if already sent/delivered/failed, skip duplicate processing
    if (
      deliveryRecord.status === 'SENT' ||
      deliveryRecord.status === 'DELIVERED' ||
      deliveryRecord.status === 'FAILED'
    ) {
      logger.info(
        { notificationId, deliveryId, status: deliveryRecord.status },
        '[NotificationWorker] Skipping already terminal delivery',
      );
      return {
        delivered: deliveryRecord.status === 'SENT' || deliveryRecord.status === 'DELIVERED',
      };
    }

    // Resolve active FCM token for user
    const fcmToken = await this.deviceRepository.findLatestFcmToken(notification.userId);
    if (!fcmToken) {
      logger.warn(
        { notificationId, deliveryId, userId: notification.userId },
        '[NotificationWorker] User has no active device with an FCM token',
      );
      await this.notificationRepository.updateDeliveryStatus(deliveryId, {
        status: 'FAILED',
        errorCode: 'NO_ACTIVE_DEVICE',
        failureReason: 'User has no active device with a valid FCM push token',
        attempts: (deliveryRecord.attempts || 0) + 1,
      });
      await this.notificationRepository.updateNotificationStatus(notificationId, 'FAILED');
      return { delivered: false, error: 'NO_ACTIVE_DEVICE' };
    }

    const title = notification.title ?? '';
    const body = notification.body ?? '';
    const payloadData = notification.data
      ? (notification.data as Record<string, string>)
      : undefined;

    const result = await this.pushProvider.sendPush({
      to: fcmToken,
      title,
      body,
      ...(payloadData ? { data: payloadData } : {}),
    });

    const attempts = (deliveryRecord.attempts || 0) + 1;

    if (result.accepted) {
      logger.info(
        { notificationId, deliveryId, providerRef: result.providerRef },
        '[NotificationWorker] Push delivered successfully',
      );
      await this.notificationRepository.updateDeliveryStatus(deliveryId, {
        status: 'SENT',
        provider: result.provider,
        providerMessageId: result.providerRef ?? null,
        sentAt: new Date(),
        attempts,
      });
      await this.notificationRepository.updateNotificationStatus(notificationId, 'SENT');
      return {
        delivered: true,
        provider: result.provider,
        providerRef: result.providerRef ?? null,
      };
    }

    // Provider push failed
    const errorCode = result.error ?? 'UNKNOWN_FCM_ERROR';
    const isInvalidToken = DEFINITIVE_INVALID_TOKEN_CODES.has(errorCode);

    if (isInvalidToken) {
      logger.warn(
        { notificationId, deliveryId, errorCode },
        '[NotificationWorker] Permanent FCM invalid token error — marking failed',
      );
      await this.notificationRepository.updateDeliveryStatus(deliveryId, {
        status: 'FAILED',
        provider: result.provider,
        errorCode,
        failureReason: 'FCM token permanently dead or invalid',
        attempts,
      });
      await this.notificationRepository.updateNotificationStatus(notificationId, 'FAILED');
      return { delivered: false, error: errorCode };
    }

    // Transient failure: update attempts & error, then throw to trigger BullMQ exponential retry
    await this.notificationRepository.updateDeliveryStatus(deliveryId, {
      attempts,
      errorCode,
      errorMessage: `FCM push attempt ${attempts} failed: ${errorCode}`,
    });

    throw new Error(`Transient FCM push failure [${errorCode}] for notification ${notificationId}`);
  }

  async markExhausted(deliveryId: string, notificationId: string, reason: string): Promise<void> {
    try {
      await this.notificationRepository.updateDeliveryStatus(deliveryId, {
        status: 'FAILED',
        failureReason: `Exhausted retries: ${reason}`,
      });
      await this.notificationRepository.updateNotificationStatus(notificationId, 'FAILED');
      logger.warn(
        { deliveryId, notificationId, reason },
        '[NotificationWorker] Marked notification as exhausted',
      );
    } catch (err) {
      logger.error(
        { err, deliveryId, notificationId },
        '[NotificationWorker] Failed to mark notification as exhausted',
      );
    }
  }
}
