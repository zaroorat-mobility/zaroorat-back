import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { container } from '../../../src/core/di.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import {
  createPushProvider,
  getNotificationConfig,
} from '../../../src/modules/notifications/notification.config.js';
import type { NotificationService } from '../../../src/modules/notifications/notification.service.js';

/// A push misconfiguration must fail push, and only push.
///
/// Regression: `getNotificationConfig` resolved PUSH_PROVIDER, and
/// `NotificationService` took the push provider in its constructor. OTP — the
/// API's OtpService and the worker's OtpDeliveryJob — builds both, so a
/// production deploy without PUSH_PROVIDER=fcm threw on every OTP send: nobody
/// could log in.
///
/// `PUSH_PROVIDER=apns` is refused in every environment ("not implemented"), so
/// this reproduces the production failure without pretending to be production.

describe('push misconfiguration is isolated from SMS', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PUSH_PROVIDER;
    process.env.PUSH_PROVIDER = 'apns';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PUSH_PROVIDER;
    else process.env.PUSH_PROVIDER = saved;
  });

  it('the SMS-side config does not read PUSH_PROVIDER', () => {
    const config = getNotificationConfig();
    assert.ok(config.smsProvider);
    assert.equal('pushProvider' in config, false);
  });

  it('push itself still refuses the bad configuration', () => {
    assert.throws(() => createPushProvider({} as DeviceRepository), /not implemented/);
  });

  it('the wired NotificationService still sends OTP; only sendPush fails', async () => {
    const service = container.resolve<NotificationService>('notificationService');

    const otp = await service.sendOtp('+919876500001', '123456');
    assert.equal(otp.accepted, true);

    await assert.rejects(service.sendPush('token', 'title', 'body'), /not implemented/);
  });
});
