import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotificationDeliveryJob } from '../../../src/modules/notifications/jobs/notification-delivery.job.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { PushProvider } from '../../../src/modules/notifications/providers/push.provider.js';

describe('NotificationDeliveryJob', () => {
  function makeStubs(opts: {
    deliveryStatus?: string;
    fcmToken?: string | null;
    pushResult?: { accepted: boolean; provider: string; providerRef?: string; error?: string };
  }) {
    const deliveryUpdates: Array<{
      id: string;
      input: { status?: string; providerMessageId?: string; errorCode?: string };
    }> = [];
    const notificationUpdates: Array<{ id: string; status: string }> = [];

    const notificationRepoStub = {
      async findDeliveryById(id: string) {
        if (id !== 'del-123') return null;
        return {
          id: 'del-123',
          notificationId: 'notif-123',
          channel: 'PUSH' as const,
          status: (opts.deliveryStatus ?? 'QUEUED') as unknown as 'QUEUED' | 'SENT' | 'FAILED',
          attempts: 0,
          notification: {
            id: 'notif-123',
            userId: 'usr-123',
            title: 'Test Title',
            body: 'Test Body',
            data: { eventId: 'evt-1' },
            status: 'QUEUED' as unknown as 'QUEUED' | 'SENT' | 'FAILED',
          },
        };
      },
      async updateDeliveryStatus(
        id: string,
        input: { status?: string; providerMessageId?: string; errorCode?: string },
      ) {
        deliveryUpdates.push({ id, input });
        return { id, ...input };
      },
      async updateNotificationStatus(id: string, status: string) {
        notificationUpdates.push({ id, status });
        return { id, status };
      },
    } as unknown as NotificationRepository;

    const deviceRepoStub = {
      async findLatestFcmToken(userId: string) {
        if (userId === 'usr-123')
          return opts.fcmToken !== undefined ? opts.fcmToken : 'valid_fcm_token_123';
        return null;
      },
    } as unknown as DeviceRepository;

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
