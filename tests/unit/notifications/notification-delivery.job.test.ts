import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotificationDeliveryJob } from '../../../src/modules/notifications/jobs/notification-delivery.job.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { PushProvider } from '../../../src/modules/notifications/providers/push.provider.js';
import { deliveryFakes } from './helpers/delivery-fakes.js';

describe('NotificationDeliveryJob', () => {
  function makeStubs(opts: {
    deliveryStatus?: string;
    fcmToken?: string | null;
    pushResult?: { accepted: boolean; provider: string; providerRef?: string; error?: string };
  }) {
    // The repositories are the shared in-memory doubles (see helpers/delivery-fakes):
    // the job now plans, claims and finalizes per device instead of reading one
    // latest token. The scenarios and assertions below are unchanged.
    const deliveryUpdates: Array<{
      id: string;
      input: { status?: string; providerMessageId?: string; errorCode?: string };
    }> = [];
    const fakes = deliveryFakes({
      onDeliveryUpdate: (id, input) => deliveryUpdates.push({ id, input }),
      notification: {
        id: 'notif-123',
        userId: 'usr-123',
        title: 'Test Title',
        body: 'Test Body',
        data: { eventId: 'evt-1' },
        status: 'QUEUED',
      },
      deliveries: [
        {
          id: 'del-123',
          notificationId: 'notif-123',
          channel: 'PUSH',
          deviceId: null,
          status: opts.deliveryStatus ?? 'QUEUED',
          attempts: 0,
        },
      ],
      devices:
        opts.fcmToken === null
          ? []
          : [{ id: 'device-1', fcmToken: opts.fcmToken ?? 'valid_fcm_token_123' }],
    });
    const notificationUpdates = fakes.notificationUpdates;
    const notificationRepoStub = fakes.notificationRepository as NotificationRepository;
    const deviceRepoStub = fakes.deviceRepository as DeviceRepository;

    let pushCalled = false;
    const pushProviderStub: PushProvider = {
      name: 'mock',
      async sendPush() {
        pushCalled = true;
        return (
          opts.pushResult ?? {
            accepted: true,
            provider: 'mock',
            providerRef: 'mock-ref-123',
          }
        );
      },
    };

    const job = new NotificationDeliveryJob(notificationRepoStub, deviceRepoStub, pushProviderStub);

    return { job, deliveryUpdates, notificationUpdates, wasPushCalled: () => pushCalled };
  }

  it('delivers push notification successfully and marks records SENT', async () => {
    const { job, deliveryUpdates, notificationUpdates, wasPushCalled } = makeStubs({
      pushResult: { accepted: true, provider: 'fcm', providerRef: 'msg-999' },
    });

    const res = await job.run({ notificationId: 'notif-123', deliveryId: 'del-123' });

    assert.equal(res.delivered, true);
    assert.equal(res.provider, 'fcm');
    assert.equal(res.providerRef, 'msg-999');
    assert.equal(wasPushCalled(), true);

    assert.equal(deliveryUpdates.length, 1);
    assert.equal(deliveryUpdates[0]!.input.status, 'SENT');
    assert.equal(deliveryUpdates[0]!.input.providerMessageId, 'msg-999');

    assert.equal(notificationUpdates.length, 1);
    assert.equal(notificationUpdates[0]!.status, 'SENT');
  });

  it('skips already terminal delivery (SENT)', async () => {
    const { job, wasPushCalled } = makeStubs({ deliveryStatus: 'SENT' });

    const res = await job.run({ notificationId: 'notif-123', deliveryId: 'del-123' });

    assert.equal(res.delivered, true);
    assert.equal(wasPushCalled(), false);
  });

  it('fails cleanly without retry when user has no active FCM device', async () => {
    const { job, deliveryUpdates, notificationUpdates, wasPushCalled } = makeStubs({
      fcmToken: null,
    });

    const res = await job.run({ notificationId: 'notif-123', deliveryId: 'del-123' });

    assert.equal(res.delivered, false);
    assert.equal(res.error, 'NO_ACTIVE_DEVICE');
    assert.equal(wasPushCalled(), false);

    assert.equal(deliveryUpdates[0]!.input.status, 'FAILED');
    assert.equal(deliveryUpdates[0]!.input.errorCode, 'NO_ACTIVE_DEVICE');
    assert.equal(notificationUpdates[0]!.status, 'FAILED');
  });

  it('handles permanent invalid token failure without throwing', async () => {
    const { job, deliveryUpdates, notificationUpdates, wasPushCalled } = makeStubs({
      pushResult: {
        accepted: false,
        provider: 'fcm',
        error: 'messaging/registration-token-not-registered',
      },
    });

    const res = await job.run({ notificationId: 'notif-123', deliveryId: 'del-123' });

    assert.equal(res.delivered, false);
    assert.equal(res.error, 'messaging/registration-token-not-registered');
    assert.equal(wasPushCalled(), true);

    assert.equal(deliveryUpdates[0]!.input.status, 'FAILED');
    assert.equal(notificationUpdates[0]!.status, 'FAILED');
  });

  it('throws Error on transient failure to trigger BullMQ retry', async () => {
    const { job, deliveryUpdates, wasPushCalled } = makeStubs({
      pushResult: { accepted: false, provider: 'fcm', error: 'messaging/server-unavailable' },
    });

    await assert.rejects(
      async () => job.run({ notificationId: 'notif-123', deliveryId: 'del-123' }),
      /Transient FCM push failure/,
    );

    assert.equal(wasPushCalled(), true);
    assert.equal(deliveryUpdates[0]!.input.errorCode, 'messaging/server-unavailable');
  });
});
