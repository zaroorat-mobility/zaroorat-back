import * as admin from 'firebase-admin';
import { logger } from '@shared/logger/index.js';
import {
  PAYLOAD_TOO_LARGE,
  type PushMessage,
  type PushProvider,
  type PushSendResult,
} from '@modules/notifications/providers/push.provider.js';
import type { DeviceRepository } from '@modules/auth/repositories/device.repository.js';

/// FCM error codes that definitively mean "this registration token no longer
/// exists or was never valid". On receiving these, the token is cleared from
/// the database so no further sends are attempted.
///
/// Critically, `messaging/invalid-argument` is NOT in this set. That code means
/// the request itself was malformed (bad payload field, wrong data type, etc.),
/// not that the token is bad. Clearing the token on an invalid-argument error
/// would cause silent push loss for a reachable device.
const DEFINITIVE_INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/// FCM error codes that represent transient server-side failures. The provider
/// marks these as not-accepted so that the existing job/retry infrastructure
/// can reschedule them. FcmPushProvider does not retry internally.
const TRANSIENT_FCM_CODES = new Set([
  'messaging/quota-exceeded',
  'messaging/server-unavailable',
  'messaging/internal-error',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/topics-message-rate-exceeded',
]);

/// FCM's documented ceiling for a data payload. Checked here, at the boundary
/// that actually talks to Google, rather than trusting every caller: an
/// oversized payload is rejected by FCM as `invalid-argument`, which this
/// provider deliberately classifies as retryable (a malformed request is a bug,
/// not a dead token) — so without this guard an over-budget payload would burn
/// the whole retry budget on a request that can never succeed.
const MAX_DATA_BYTES = 4096;

/// Re-exported for the tests that assert this provider's behaviour. The constant
/// itself lives on the provider contract, because recognising it as permanent is
/// every caller's concern, not this implementation's.
export { PAYLOAD_TOO_LARGE };

export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';

  constructor(
    private readonly app: admin.app.App,
    private readonly deviceRepository: DeviceRepository,
  ) {}

  async sendPush(message: PushMessage): Promise<PushSendResult> {
    const tokenSuffix = message.to.slice(-8);

    if (message.data) {
      const bytes = Buffer.byteLength(JSON.stringify(message.data), 'utf8');
      if (bytes > MAX_DATA_BYTES) {
        logger.error(
          { tokenSuffix, provider: this.name, dataBytes: bytes, limit: MAX_DATA_BYTES },
          '[FCM] data payload over budget — refusing to send',
        );
        return { accepted: false, provider: this.name, error: PAYLOAD_TOO_LARGE };
      }
    }

    const fcmMessage: admin.messaging.Message = {
      token: message.to,
      // Always present. Firebase throttles high-priority messages that do not
      // result in a user-visible notification, so `android.priority: 'high'`
      // below is only durable while every message carries this block.
      notification: {
        title: message.title,
        body: message.body,
      },
      // Android: override battery-optimisation delivery delay so backgrounded
      // drivers receive dispatch offers immediately.
      //
      // `priority` controls *when* FCM delivers. Channel importance controls
      // *how* Android presents it, and is set by the app when it creates the
      // channel — so a heads-up ride offer needs both, which is why
      // `channelId` is addressed per message rather than fixed here.
      android: {
        priority: 'high',
        ...(message.ttlMs !== undefined ? { ttl: message.ttlMs } : {}),
        ...(message.collapseKey ? { collapseKey: message.collapseKey } : {}),
        ...(message.channelId || message.sound
          ? {
              notification: {
                ...(message.channelId ? { channelId: message.channelId } : {}),
                ...(message.sound ? { sound: message.sound } : {}),
              },
            }
          : {}),
      },
      // APNs (iOS): explicit alert so the notification appears in all app states
      // (foreground, background, killed). 'default' sound plays the system chime.
      apns: {
        payload: {
          aps: {
            alert: {
              title: message.title,
              body: message.body,
            },
            sound: 'default',
          },
        },
        headers: {
          // 'alert' push-type is required for user-visible notifications on iOS 13+.
          'apns-push-type': 'alert',
          // High priority (10) delivers immediately rather than at the system's
          // discretion. Required for time-sensitive ride events.
          'apns-priority': '10',
          // APNs takes an absolute expiry instant in unix seconds, where Android
          // takes a relative duration. Same intent, different units. An explicit
          // `expiresAt` wins; it is floored, so APNs never holds a message past it.
          ...(message.expiresAt
            ? { 'apns-expiration': String(Math.floor(message.expiresAt.getTime() / 1000)) }
            : message.ttlMs !== undefined
              ? { 'apns-expiration': String(Math.floor((Date.now() + message.ttlMs) / 1000)) }
              : {}),
          ...(message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {}),
        },
      },
      ...(message.data ? { data: message.data } : {}),
    };

    try {
      const messageId = await this.app.messaging().send(fcmMessage);
      logger.info(
        { tokenSuffix, providerRef: messageId, provider: this.name, title: message.title },
        '[FCM] sent',
      );
      return { accepted: true, provider: this.name, providerRef: messageId };
    } catch (err: unknown) {
      return this.handleFcmError(err, message.to, tokenSuffix);
    }
  }

  private async handleFcmError(
    err: unknown,
    token: string,
    tokenSuffix: string,
  ): Promise<PushSendResult> {
    const code = this.extractFcmCode(err);
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (DEFINITIVE_INVALID_TOKEN_CODES.has(code)) {
      // The token is permanently dead. Clear it so no further sends are
      // attempted. Log before the async clear so we have a record even if the
      // DB write fails.
      logger.warn(
        { tokenSuffix, fcmCode: code, provider: this.name },
        '[FCM] token invalid — clearing from device registry',
      );
      try {
        await this.deviceRepository.clearFcmTokenByValue(token);
      } catch (dbErr) {
        // Non-fatal: the push already failed. The DB error is logged separately
        // so it doesn't mask the original FCM failure.
        logger.error(
          { tokenSuffix, provider: this.name, err: dbErr },
          '[FCM] failed to clear invalid token from device registry',
        );
      }
      return { accepted: false, provider: this.name, error: code };
    }

    const isTransient = TRANSIENT_FCM_CODES.has(code) || code === 'unknown';
    const logLevel = isTransient ? 'warn' : 'error';
    logger[logLevel](
      { tokenSuffix, fcmCode: code, provider: this.name, errorMessage },
      '[FCM] send failed',
    );

    return { accepted: false, provider: this.name, error: code };
  }

  private extractFcmCode(err: unknown): string {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
    ) {
      return (err as { code: string }).code;
    }
    return 'unknown';
  }
}
