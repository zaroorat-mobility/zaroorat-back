import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotificationDeliveryJob } from '../../../src/modules/notifications/jobs/notification-delivery.job.js';
import { PAYLOAD_TOO_LARGE } from '../../../src/modules/notifications/providers/push.provider.js';
import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import type {
  PushMessage,
  PushProvider,
} from '../../../src/modules/notifications/providers/push.provider.js';
import { deliveryFakes } from './helpers/delivery-fakes.js';

/// PA-2: what the delivery job hands the provider.
///
/// The existing `notification-delivery.job.test.ts` covers the state machine —
/// terminal-state skip, invalid token, transient retry. It stubs `sendPush()` with
/// no parameters, so it cannot see the message. This suite captures it.

function counter(name: string): number {
  return snapshotMetrics().find((s) => s.name === name)?.value ?? 0;
}

function makeJob(opts: {
  data?: unknown;
  eventKey?: string | null;
  fcmToken?: string | null;
  pushResult?: { accepted: boolean; provider: string; providerRef?: string; error?: string };
}) {
  let captured: PushMessage | undefined;

  // Shared in-memory repositories (helpers/delivery-fakes): the job plans,
  // claims and finalizes per device. Scenarios and assertions are unchanged.
  const fakes = deliveryFakes({
    notification: {
      id: 'notif-1',
      userId: 'usr-1',
      title: 'Title',
      body: 'Body',
      eventKey: opts.eventKey === undefined ? 'ride.accepted' : opts.eventKey,
      data: opts.data === undefined ? { eventId: 'evt-1' } : opts.data,
      status: 'QUEUED',
    },
    deliveries: [
      {
        id: 'del-1',
        notificationId: 'notif-1',
        channel: 'PUSH',
        deviceId: null,
        status: 'QUEUED',
        attempts: 0,
      },
    ],
    devices:
      opts.fcmToken === null
        ? []
        : [{ id: 'device-1', fcmToken: opts.fcmToken ?? 'token_abcdef12' }],
  });
  const { deliveryUpdates, notificationUpdates } = fakes;

  const pushProviderStub: PushProvider = {
    name: 'mock',
    async sendPush(message: PushMessage) {
      captured = message;
      return opts.pushResult ?? { accepted: true, provider: 'mock', providerRef: 'ref-1' };
    },
  };

  const job = new NotificationDeliveryJob(
    fakes.notificationRepository,
    fakes.deviceRepository,
    pushProviderStub,
  );
  return { job, deliveryUpdates, notificationUpdates, captured: () => captured };
}

const JOB = { notificationId: 'notif-1', deliveryId: 'del-1' };

describe('PA-2 — delivery ids are merged at send time', () => {
  it('adds notificationId and deliveryId to the outgoing data payload', async () => {
    const { job, captured } = makeJob({});
    await job.run(JOB);

    assert.equal(captured()?.data?.notificationId, 'notif-1');
    assert.equal(captured()?.data?.deliveryId, 'del-1');
    // The stored payload's own fields survive alongside them.
    assert.equal(captured()?.data?.eventId, 'evt-1');
  });

  it('cannot be shadowed by a stored value claiming the same key', async () => {
    // A stored payload must never be able to misattribute a delivery — the real
    // ids are merged last precisely so this is impossible.
    const { job, captured } = makeJob({
      data: { eventId: 'evt-1', notificationId: 'FORGED', deliveryId: 'FORGED' },
    });
    await job.run(JOB);

    assert.equal(captured()?.data?.notificationId, 'notif-1');
    assert.equal(captured()?.data?.deliveryId, 'del-1');
  });

  it('still sends the ids when the stored payload is empty or absent', async () => {
    for (const data of [null, {}, undefined]) {
      const { job, captured } = makeJob({ data });
      await job.run(JOB);
      assert.equal(captured()?.data?.notificationId, 'notif-1', `failed for data=${String(data)}`);
      assert.equal(captured()?.data?.deliveryId, 'del-1');
    }
  });
});

describe('PA-2 — every value handed to the provider is a string', () => {
  it('drops non-string values rather than passing them to FCM', async () => {
    const { job, captured } = makeJob({
      data: {
        eventId: 'evt-1',
        attempts: 3,
        isTest: true,
        nested: { a: 'b' },
        nothing: null,
        list: ['a'],
      },
    });
    await job.run(JOB);

    const sent = captured()?.data ?? {};
    for (const [key, value] of Object.entries(sent)) {
      assert.equal(typeof value, 'string', `${key} reached the provider as ${typeof value}`);
    }
    assert.equal(sent.eventId, 'evt-1', 'the valid string value survives');
    for (const dropped of ['attempts', 'isTest', 'nested', 'nothing', 'list']) {
      assert.ok(!(dropped in sent), `${dropped} must have been dropped`);
    }
  });

  it('tolerates a stored payload that is not an object at all', async () => {
    for (const data of ['a string', 42, ['x']]) {
      const { job, captured } = makeJob({ data });
      await job.run(JOB);
      // Degrades to just the ids rather than throwing.
      assert.deepEqual(Object.keys(captured()?.data ?? {}).sort(), [
        'deliveryId',
        'notificationId',
      ]);
    }
  });
});

describe('PA-2 — presentation is derived from the delivery class', () => {
  it('uses the class stamped in the payload', async () => {
    const { job, captured } = makeJob({
      data: { category: 'RIDE_OFFER', dispatchId: 'dsp-1' },
      eventKey: 'ride.dispatch.offered',
    });
    await job.run(JOB);

    assert.equal(captured()?.channelId, 'ride-offer');
    assert.equal(captured()?.ttlMs, 45_000);
    assert.equal(captured()?.collapseKey, 'offer:dsp-1');
  });

  it('falls back to the event key when the payload predates the class field', async () => {
    // A job enqueued before PA-1 shipped carries no `category`.
    const { job, captured } = makeJob({
      data: { eventId: 'evt-1', rideId: 'ride-9' },
      eventKey: 'ride.accepted',
    });
    await job.run(JOB);

    assert.equal(captured()?.channelId, 'ride');
    assert.equal(captured()?.ttlMs, 3_600_000);
    assert.equal(captured()?.collapseKey, 'ride:ride-9:status');
  });

  it('degrades to TRANSACTIONAL for an unrecognised class rather than failing', async () => {
    const { job, captured } = makeJob({
      data: { category: 'NOT_A_REAL_CLASS', rideId: 'ride-9' },
      eventKey: null,
    });
    await job.run(JOB);

    assert.equal(captured()?.channelId, 'ride');
    assert.equal(captured()?.ttlMs, 3_600_000);
  });

  it('gives payment outcomes their own collapse key, so a status push is not superseded', async () => {
    const { job, captured } = makeJob({
      data: { category: 'TRANSACTIONAL', rideId: 'ride-9' },
      eventKey: 'payment.ride.collected',
    });
    await job.run(JOB);

    assert.equal(captured()?.collapseKey, 'ride:ride-9:payment');
  });

  it('omits the collapse key when there is no subject id to collapse against', async () => {
    const { job, captured } = makeJob({
      data: { category: 'TRANSACTIONAL', eventId: 'evt-1' },
      eventKey: 'ride.request.expired',
    });
    await job.run(JOB);

    assert.equal(captured()?.collapseKey, undefined);
  });
});

describe('PA-2 — an oversized payload fails permanently, not repeatedly', () => {
  it('marks FAILED without throwing, so BullMQ does not retry it', async () => {
    const { job, deliveryUpdates, notificationUpdates } = makeJob({
      pushResult: { accepted: false, provider: 'fcm', error: PAYLOAD_TOO_LARGE },
    });

    // Throwing is how this pipeline signals "retry me". It must not throw here:
    // a later attempt would send the same oversized payload.
    const result = await job.run(JOB);

    assert.equal(result.delivered, false);
    assert.equal(result.error, PAYLOAD_TOO_LARGE);
    assert.equal(deliveryUpdates.at(-1)?.status, 'FAILED');
    assert.match(String(deliveryUpdates.at(-1)?.failureReason), /exceeded the transport limit/);
    assert.deepEqual(notificationUpdates.at(-1), { id: 'notif-1', status: 'FAILED' });
  });

  it('still throws for a transient provider error, preserving retry', async () => {
    const { job } = makeJob({
      pushResult: { accepted: false, provider: 'fcm', error: 'messaging/server-unavailable' },
    });
    await assert.rejects(() => job.run(JOB), /Transient FCM push failure/);
  });

  it('still marks FAILED without retry for a definitively invalid token', async () => {
    const { job, deliveryUpdates } = makeJob({
      pushResult: {
        accepted: false,
        provider: 'fcm',
        error: 'messaging/registration-token-not-registered',
      },
    });
    const result = await job.run(JOB);

    assert.equal(result.delivered, false);
    assert.equal(deliveryUpdates.at(-1)?.status, 'FAILED');
    assert.match(String(deliveryUpdates.at(-1)?.failureReason), /permanently dead or invalid/);
  });
});

describe('PA-2 — no_active_device is counted', () => {
  it('increments the counter and keeps the existing FAILED handling', async () => {
    resetMetrics();
    const { job, deliveryUpdates, notificationUpdates } = makeJob({ fcmToken: null });

    const result = await job.run({ ...JOB, eventType: 'ride.accepted', category: 'TRANSACTIONAL' });

    assert.equal(result.error, 'NO_ACTIVE_DEVICE');
    assert.equal(counter('notification_no_active_device'), 1);
    // Unchanged from before PA-2: no retry, both rows terminal.
    assert.equal(deliveryUpdates.at(-1)?.status, 'FAILED');
    assert.equal(deliveryUpdates.at(-1)?.errorCode, 'NO_ACTIVE_DEVICE');
    assert.deepEqual(notificationUpdates.at(-1), { id: 'notif-1', status: 'FAILED' });
  });

  it('does not count a successful delivery as a missing device', async () => {
    resetMetrics();
    const { job } = makeJob({});
    await job.run(JOB);
    assert.equal(counter('notification_no_active_device'), 0);
  });
});

describe('PA-2 — terminal-state protection is preserved', () => {
  it('does not call the provider for a delivery that is already terminal', async () => {
    // Guards the double-send protection that makes a BullMQ redelivery safe.
    for (const status of ['SENT', 'DELIVERED', 'FAILED']) {
      const deliveryUpdates: Array<Record<string, unknown>> = [];
      let pushCalled = false;

      const fakes = deliveryFakes({
        notification: {
          id: 'notif-1',
          userId: 'usr-1',
          title: 'T',
          body: 'B',
          eventKey: 'ride.accepted',
          data: {},
          status,
        },
        deliveries: [
          {
            id: 'del-1',
            notificationId: 'notif-1',
            channel: 'PUSH',
            deviceId: null,
            status,
            attempts: 1,
          },
        ],
        devices: [{ id: 'device-1', fcmToken: 'token_abcdef12' }],
        onDeliveryUpdate: (id, input) => deliveryUpdates.push({ id, ...input }),
      });

      const job = new NotificationDeliveryJob(
        fakes.notificationRepository,
        fakes.deviceRepository,
        {
          name: 'mock',
          async sendPush() {
            pushCalled = true;
            return { accepted: true, provider: 'mock' };
          },
        },
      );

      await job.run(JOB);
      assert.equal(pushCalled, false, `provider must not be called for status ${status}`);
      assert.equal(deliveryUpdates.length, 0, `no writes for status ${status}`);
    }
  });
});
