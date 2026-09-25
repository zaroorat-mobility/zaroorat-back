import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveOfferWindow } from '../../../src/modules/notifications/policies/notification-priority.policy.js';
import { NotificationDeliveryJob } from '../../../src/modules/notifications/jobs/notification-delivery.job.js';
import { FcmPushProvider } from '../../../src/integrations/firebase/fcm-push.provider.js';
import { RideNotificationConsumer } from '../../../src/modules/rides/consumers/ride-notification.consumer.js';
import type {
  PushMessage,
  PushProvider,
  PushSendResult,
} from '../../../src/modules/notifications/providers/push.provider.js';
import type { EventBus, EventEnvelope } from '../../../src/core/events';
import { deliveryFakes } from './helpers/delivery-fakes.js';

/// Phase 3A — a ride-offer push lives exactly as long as the offer.
///
/// Every time is a fixed timestamp handed in as the clock; nothing sleeps.

const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe('resolveOfferWindow', () => {
  it('a fresh 10-second offer: TTL is the full 10 seconds, expiry is the offer expiry', () => {
    const window = resolveOfferWindow(at(10_000), T0);
    assert.deepEqual(window, { expired: false, ttlMs: 10_000, expiresAt: new Date(T0 + 10_000) });
  });

  it('5 seconds remaining → 5-second TTL', () => {
    assert.equal((resolveOfferWindow(at(10_000), T0 + 5_000) as { ttlMs: number }).ttlMs, 5_000);
  });

  it('1 second remaining → 1-second TTL', () => {
    assert.equal((resolveOfferWindow(at(10_000), T0 + 9_000) as { ttlMs: number }).ttlMs, 1_000);
  });

  it('already expired → expired', () => {
    assert.deepEqual(resolveOfferWindow(at(10_000), T0 + 11_000), { expired: true });
  });

  it('clock boundary: exactly at expiresAt is expired, 1ms before is not', () => {
    assert.deepEqual(resolveOfferWindow(at(10_000), T0 + 10_000), { expired: true });
    assert.equal((resolveOfferWindow(at(10_000), T0 + 9_999) as { ttlMs: number }).ttlMs, 1);
  });

  it('no usable expiresAt → null, so the class TTL applies', () => {
    for (const value of [undefined, null, '', 'not-a-date', 42]) {
      assert.equal(resolveOfferWindow(value, T0), null, String(value));
    }
  });
});

function jobFor(
  data: Record<string, string>,
  eventKey: string,
  script: (m: PushMessage) => PushSendResult = () => ({ accepted: true, provider: 'mock' }),
) {
  const sent: PushMessage[] = [];
  const fakes = deliveryFakes({
    notification: {
      id: 'n-1',
      userId: 'u-1',
      title: 'T',
      body: 'B',
      eventKey,
      data,
      status: 'QUEUED',
    },
    deliveries: [
      {
        id: 'd-1',
        notificationId: 'n-1',
        channel: 'PUSH',
        deviceId: null,
        status: 'QUEUED',
        attempts: 0,
      },
    ],
    devices: [{ id: 'dev-1', fcmToken: 'tok-1' }],
  });
  const provider: PushProvider = {
    name: 'mock',
    async sendPush(m) {
      sent.push(m);
      return script(m);
    },
  };
  const job = new NotificationDeliveryJob(
    fakes.notificationRepository,
    fakes.deviceRepository,
    provider,
  );
  return { job, sent, fakes };
}

const OFFER = (expiresAt: string) => ({
  category: 'RIDE_OFFER',
  dispatchId: 'dsp-1',
  eventId: 'evt-1',
  expiresAt,
});
const RUN = { notificationId: 'n-1', deliveryId: 'd-1' };

describe('delivery job — offer TTL', () => {
  it('sends a 10-second offer with a 10-second TTL and the offer expiry', async () => {
    const { job, sent } = jobFor(OFFER(at(10_000)), 'ride.dispatch.offered');
    await job.run(RUN, () => T0);
    assert.equal(sent[0]!.ttlMs, 10_000);
    assert.equal(sent[0]!.expiresAt?.getTime(), T0 + 10_000);
  });

  it('sends with the time left, not the class TTL, when 5s or 1s remain', async () => {
    for (const [now, ttl] of [
      [T0 + 5_000, 5_000],
      [T0 + 9_000, 1_000],
    ] as const) {
      const { job, sent } = jobFor(OFFER(at(10_000)), 'ride.dispatch.offered');
      await job.run(RUN, () => now);
      assert.equal(sent[0]!.ttlMs, ttl);
      assert.ok(sent[0]!.ttlMs! < 45_000, 'never the 45s class TTL');
    }
  });

  it('does not send an expired offer, fails it once, and does not throw', async () => {
    const { job, sent, fakes } = jobFor(OFFER(at(10_000)), 'ride.dispatch.offered');
    const result = await job.run(RUN, () => T0 + 10_000);
    assert.equal(sent.length, 0);
    assert.equal(result.delivered, false);
    assert.equal(result.error, 'OFFER_EXPIRED');
    assert.equal(fakes.deliveries[0]!.status, 'FAILED');
    assert.equal(fakes.notification.status, 'FAILED');
  });

  it('a retry after the window closed sends nothing', async () => {
    let fail = true;
    const { job, sent, fakes } = jobFor(OFFER(at(10_000)), 'ride.dispatch.offered', () =>
      fail
        ? { accepted: false, provider: 'mock', error: 'messaging/server-unavailable' }
        : { accepted: true, provider: 'mock' },
    );
    await assert.rejects(() => job.run(RUN, () => T0), /Transient FCM push failure/);
    fail = false;

    await job.run(RUN, () => T0 + 15_000); // the 5s + 10s backoff has passed the window

    assert.equal(sent.length, 1, 'only the first, failed attempt was sent');
    assert.equal(fakes.deliveries[0]!.status, 'FAILED');
    assert.equal(fakes.deliveries[0]!.errorCode, 'OFFER_EXPIRED');
  });

  it('a retry inside the window sends with the smaller remaining TTL', async () => {
    let fail = true;
    const { job, sent } = jobFor(OFFER(at(10_000)), 'ride.dispatch.offered', () =>
      fail
        ? { accepted: false, provider: 'mock', error: 'messaging/server-unavailable' }
        : { accepted: true, provider: 'mock' },
    );
    await assert.rejects(() => job.run(RUN, () => T0));
    fail = false;
    await job.run(RUN, () => T0 + 5_000);
    assert.deepEqual(
      sent.map((m) => m.ttlMs),
      [10_000, 5_000],
    );
  });

  it('leaves non-offer notifications on their class TTL and without an expiry', async () => {
    const { job, sent } = jobFor(
      { category: 'TRANSACTIONAL', rideId: 'r-1', expiresAt: at(1_000) },
      'ride.accepted',
    );
    await job.run(RUN, () => T0 + 60_000);
    assert.equal(sent[0]!.ttlMs, 3_600_000);
    assert.equal(sent[0]!.expiresAt, undefined);
  });
});

describe('FcmPushProvider — APNs expiration', () => {
  function capture() {
    type Sent = {
      apns: { headers: Record<string, string> };
      android: { ttl?: number };
    };
    let message: Sent | undefined;
    const app = {
      messaging: () => ({
        send: async (m: Sent) => {
          message = m;
          return 'msg-1';
        },
      }),
    };
    const provider = new FcmPushProvider(
      app as never,
      { clearFcmTokenByValue: async () => {} } as never,
    );
    return { provider, message: () => message! };
  }

  it('uses the offer expiry for APNs and the remaining lifetime for Android', async () => {
    const { provider, message } = capture();
    await provider.sendPush({
      to: 't',
      title: 'T',
      body: 'B',
      ttlMs: 5_000,
      expiresAt: new Date(T0 + 5_000),
    });
    assert.equal(message().apns.headers['apns-expiration'], String((T0 + 5_000) / 1000));
    assert.equal(message().android.ttl, 5_000);
  });

  it('floors a fractional second, so APNs never holds the message past the offer', async () => {
    const { provider, message } = capture();
    await provider.sendPush({
      to: 't',
      title: 'T',
      body: 'B',
      ttlMs: 900,
      expiresAt: new Date(T0 + 5_900),
    });
    assert.equal(message().apns.headers['apns-expiration'], String((T0 + 5_000) / 1000));
  });
});

describe('RideNotificationConsumer — expired offers are not enqueued', () => {
  it('records the notification FAILED with OFFER_EXPIRED and never reaches the queue', async () => {
    const handlers = new Map<string, (e: EventEnvelope) => Promise<void>>();
    const eventBus = {
      on: (type: string, handler: (e: EventEnvelope) => Promise<void>) => {
        handlers.set(type, handler);
        return () => {};
      },
    } as unknown as EventBus;
    const deliveryUpdates: Array<Record<string, unknown>> = [];
    const notificationUpdates: string[] = [];
    const consumer = new RideNotificationConsumer(
      eventBus,
      {} as never,
      { findById: async () => ({ id: 'drv-1', userId: 'u-1' }) } as never,
      {} as never,
      {
        async createNotificationWithDelivery() {
          return {
            notification: { id: 'n-1' },
            delivery: { id: 'd-1' },
            isDuplicate: false,
          };
        },
        async updateDeliveryStatus(_id: string, input: Record<string, unknown>) {
          deliveryUpdates.push(input);
        },
        async updateNotificationStatus(_id: string, status: string) {
          notificationUpdates.push(status);
        },
      } as never,
    );
    consumer.register();

    await handlers.get('ride.dispatch.offered')!({
      eventId: 'evt-1',
      type: 'ride.dispatch.offered',
      occurredAt: new Date(Date.now() - 20_000).toISOString(),
      data: {
        driverId: 'drv-1',
        dispatchId: 'dsp-1',
        requestId: 'req-1',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    } as unknown as EventEnvelope);

    assert.deepEqual(deliveryUpdates, [
      {
        status: 'FAILED',
        errorCode: 'OFFER_EXPIRED',
        failureReason: 'Ride offer expired before its notification was enqueued',
      },
    ]);
    assert.deepEqual(notificationUpdates, ['FAILED']);
  });
});
