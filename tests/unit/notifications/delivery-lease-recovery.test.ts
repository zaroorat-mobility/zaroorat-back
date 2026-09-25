import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotificationDeliveryJob } from '../../../src/modules/notifications/jobs/notification-delivery.job.js';
import type {
  PushMessage,
  PushProvider,
  PushSendResult,
} from '../../../src/modules/notifications/providers/push.provider.js';
import { deliveryFakes } from './helpers/delivery-fakes.js';

/// F1 — a delivery whose lease is held elsewhere is retried, never completed as
/// done; a provider exception gives the lease back. The PostgreSQL suite proves
/// the same against real SQL; these pin the job's decisions in isolation.

const RUN = { notificationId: 'n-1', deliveryId: 'd-1' };

function setup(opts: {
  devices?: Array<{ id: string; fcmToken: string }>;
  leasedElsewhere?: string[];
  status?: string;
  script?: (m: PushMessage) => PushSendResult | Promise<PushSendResult>;
}) {
  const sent: PushMessage[] = [];
  const fakes = deliveryFakes({
    notification: {
      id: 'n-1',
      userId: 'u-1',
      title: 'T',
      body: 'B',
      eventKey: 'ride.accepted',
      data: { category: 'TRANSACTIONAL', rideId: 'r-1' },
      status: 'QUEUED',
    },
    deliveries: [
      {
        id: 'd-1',
        notificationId: 'n-1',
        channel: 'PUSH',
        deviceId: null,
        status: opts.status ?? 'QUEUED',
        attempts: 0,
      },
    ],
    devices: opts.devices ?? [{ id: 'dev-1', fcmToken: 'tok-1' }],
    ...(opts.leasedElsewhere ? { leasedElsewhere: opts.leasedElsewhere } : {}),
  });
  const provider: PushProvider = {
    name: 'mock',
    async sendPush(m) {
      sent.push(m);
      return opts.script ? opts.script(m) : { accepted: true, provider: 'mock' };
    },
  };
  const job = new NotificationDeliveryJob(
    fakes.notificationRepository,
    fakes.deviceRepository,
    provider,
  );
  return { job, sent, fakes };
}

describe('F1 · a held lease is retryable, never done', () => {
  it('throws a retryable error and leaves the delivery QUEUED, unsent and unfailed', async () => {
    const { job, sent, fakes } = setup({ leasedElsewhere: ['d-1'] });

    await assert.rejects(() => job.run(RUN), /Delivery lease held by another attempt/);

    assert.equal(sent.length, 0);
    assert.equal(fakes.deliveries[0]!.status, 'QUEUED');
    assert.equal(fakes.deliveries[0]!.attempts, 0, 'no claim was taken');
    assert.equal(fakes.notification.status, 'QUEUED');
  });

  it('once the holder lets go, the retry claims and sends', async () => {
    const { job, sent, fakes } = setup({ leasedElsewhere: ['d-1'] });
    await assert.rejects(() => job.run(RUN));

    fakes.leasedElsewhere.clear(); // released, or expired
    const result = await job.run(RUN);

    assert.equal(result.delivered, true);
    assert.equal(sent.length, 1);
    assert.equal(fakes.deliveries[0]!.status, 'SENT');
  });

  it('still sends to the other devices in the same run before throwing', async () => {
    const { job, sent, fakes } = setup({
      devices: [
        { id: 'dev-1', fcmToken: 'tok-1' },
        { id: 'dev-2', fcmToken: 'tok-2' },
      ],
      leasedElsewhere: ['d-1'],
    });

    await assert.rejects(() => job.run(RUN), /Delivery lease held by another attempt/);

    assert.deepEqual(
      sent.map((m) => m.to),
      ['tok-2'],
    );
    assert.equal(fakes.notification.status, 'SENT', 'settled before the throw');
  });

  it('does not retry a delivery another attempt already finished', async () => {
    const { job, sent } = setup({ status: 'SENT' });
    const result = await job.run(RUN);
    assert.equal(result.delivered, true);
    assert.equal(sent.length, 0);
  });
});

describe('F1 · a provider exception releases the lease and propagates', () => {
  it('releases its own lease, keeps the delivery QUEUED, rethrows the original error', async () => {
    const boom = new Error('provider exploded');
    const { job, fakes } = setup({
      script: () => {
        throw boom;
      },
    });

    await assert.rejects(
      () => job.run(RUN),
      (err: unknown) => err === boom,
    );

    assert.equal(fakes.leases.size, 0, 'lease released');
    assert.equal(fakes.deliveries[0]!.status, 'QUEUED');
    assert.equal(fakes.deliveries[0]!.errorCode, 'PROVIDER_EXCEPTION');
  });

  it('the retry claims immediately and the delivery becomes SENT', async () => {
    let throws = 1;
    const { job, fakes, sent } = setup({
      script: () => {
        if (throws-- > 0) throw new Error('provider exploded');
        return { accepted: true, provider: 'mock' };
      },
    });
    await assert.rejects(() => job.run(RUN));

    await job.run(RUN);

    assert.equal(sent.length, 2);
    assert.equal(fakes.deliveries[0]!.status, 'SENT');
    assert.equal(fakes.deliveries[0]!.attempts, 2);
  });

  it('a failed release does not mask the provider exception', async () => {
    const boom = new Error('provider exploded');
    const { job, fakes } = setup({
      script: () => {
        throw boom;
      },
    });
    (
      fakes.notificationRepository as unknown as { releaseDelivery: () => Promise<never> }
    ).releaseDelivery = async () => {
      throw new Error('database unavailable');
    };

    await assert.rejects(
      () => job.run(RUN),
      (err: unknown) => err === boom,
    );
  });

  it('settles the notification before the exception propagates', async () => {
    const { job, fakes } = setup({
      devices: [
        { id: 'dev-1', fcmToken: 'tok-1' },
        { id: 'dev-2', fcmToken: 'tok-2' },
      ],
      script: (m) => {
        if (m.to === 'tok-2') throw new Error('provider exploded');
        return { accepted: true, provider: 'mock' };
      },
    });

    await assert.rejects(() => job.run(RUN), /provider exploded/);

    assert.equal(fakes.deliveries.find((d) => d.deviceId === 'dev-1')!.status, 'SENT');
    assert.equal(fakes.notification.status, 'SENT');
  });
});
