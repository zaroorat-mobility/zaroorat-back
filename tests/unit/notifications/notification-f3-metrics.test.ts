import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  SAFE_LABELS,
  resetMetrics,
  snapshotMetrics,
  type MetricSample,
} from '../../../src/core/metrics/index.js';
import {
  notificationEventReconciliationCount,
  notificationEventReconciliationGauge,
  notificationLiveFailure,
} from '../../../src/modules/notifications/metrics/notification.metrics.js';
import { RideNotificationConsumer } from '../../../src/modules/rides/consumers/ride-notification.consumer.js';
import { closeQueues, notificationsQueue } from '../../../src/jobs/queues/index.js';
import { logger } from '../../../src/shared/logger/index.js';
import type { EventBus, EventEnvelope } from '../../../src/core/events';
import type { RideRepository } from '../../../src/modules/rides/repositories/ride.repository.js';
import type { DriverRepository } from '../../../src/modules/drivers/repositories/driver.repository.js';
import type { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import {
  CUSTOMER_USER,
  DRIVERS,
  NOTIFICATION_EVENT_TYPES,
  RIDE,
  RIDES,
  envelopeFor,
} from './ride-notification.golden.js';

/// F3 S7 — the notification metrics the reconciliation and the live path emit.
/// The reconciliation job's own emission is exercised against PostgreSQL in
/// tests/integration/notification-event-reconciliation-metrics-postgres.test.ts.

const F3_LABEL_KEYS = ['event_type', 'category', 'reason', 'result', 'scope'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function series(prefix: string): MetricSample[] {
  return snapshotMetrics().filter((sample) => sample.name.startsWith(prefix));
}

/// The sample with exactly these labels, in any order.
function value(name: string, labels: Record<string, string> = {}): number {
  const want = Object.entries(labels).sort().join('|');
  const sample = snapshotMetrics().find(
    (s) => s.name === name && Object.entries(s.labels).sort().join('|') === want,
  );
  return sample?.value ?? 0;
}

after(async () => {
  await closeQueues();
});

describe('F3 metric functions', () => {
  it('uses only label keys the registry keeps — any other key would be silently dropped', () => {
    for (const key of F3_LABEL_KEYS) assert.ok(SAFE_LABELS.includes(key), key);
  });

  it('counts reconciliation outcomes under notification_event_reconciliation_*, by any amount', () => {
    resetMetrics();
    notificationEventReconciliationCount('recovered', {
      event_type: 'ride.started',
      category: 'TRANSACTIONAL',
    });
    notificationEventReconciliationCount(
      'recovered_age_seconds_total',
      { event_type: 'ride.started' },
      121.5,
    );
    notificationEventReconciliationCount('runs', { result: 'caught_up', scope: 'on' });
    assert.equal(
      value('notification_event_reconciliation_recovered', {
        event_type: 'ride.started',
        category: 'TRANSACTIONAL',
      }),
      1,
    );
    assert.equal(
      value('notification_event_reconciliation_recovered_age_seconds_total', {
        event_type: 'ride.started',
      }),
      121.5,
    );
    assert.equal(
      value('notification_event_reconciliation_runs', { result: 'caught_up', scope: 'on' }),
      1,
    );
  });

  it('sets reconciliation gauges to the latest value', () => {
    resetMetrics();
    notificationEventReconciliationGauge('lag_seconds', 300);
    notificationEventReconciliationGauge('lag_seconds', 0);
    const [sample] = series('notification_event_reconciliation_lag_seconds');
    assert.equal(sample?.type, 'gauge');
    assert.equal(sample?.value, 0);
  });

  it('counts live-path failures under notification_live_*, and never throws', () => {
    resetMetrics();
    notificationLiveFailure('persist_failed', {
      event_type: 'ride.started',
      category: 'TRANSACTIONAL',
    });
    assert.equal(
      value('notification_live_persist_failed', {
        event_type: 'ride.started',
        category: 'TRANSACTIONAL',
      }),
      1,
    );

    const realInfo = logger.info;
    logger.info = (() => {
      throw new Error('log sink down');
    }) as unknown as typeof logger.info;
    try {
      assert.doesNotThrow(() =>
        notificationLiveFailure('lookup_failed', { event_type: 'ride.started' }),
      );
    } finally {
      logger.info = realInfo;
    }
  });
});

// ── The live consumer ────────────────────────────────────────────────────────

type Handler = (envelope: EventEnvelope) => Promise<void>;

interface LiveFaults {
  rideLookupFails?: boolean;
  insertFails?: boolean;
  enqueueRejects?: boolean;
}

async function deliver(type: string, data: Record<string, unknown>, faults: LiveFaults = {}) {
  const handlers = new Map<string, Handler>();
  const warnings: string[] = [];
  new RideNotificationConsumer(
    {
      on(eventType: string, handler: Handler) {
        handlers.set(eventType, handler);
        return () => handlers.delete(eventType);
      },
    } as unknown as EventBus,
    {
      async findById(id: string) {
        if (faults.rideLookupFails) throw new Error('simulated ride lookup failure');
        const ride = RIDES[id];
        return ride ? { id, ...ride } : null;
      },
    } as unknown as RideRepository,
    {
      async findById(id: string) {
        const driver = DRIVERS[id];
        return driver ? { id, ...driver } : null;
      },
    } as unknown as DriverRepository,
    {} as unknown as DeviceRepository,
    {
      async createNotificationWithDelivery(input: Record<string, unknown>) {
        if (faults.insertFails) throw new Error('simulated notification insert failure');
        return {
          notification: { id: 'notif-1', status: 'QUEUED', ...input },
          delivery: { id: 'del-1', channel: 'PUSH', status: 'QUEUED' },
          isDuplicate: false,
        };
      },
    } as unknown as NotificationRepository,
  ).register();

  const queue = notificationsQueue();
  const realAdd = queue.add.bind(queue);
  const realWarn = logger.warn;
  (queue as unknown as Record<string, unknown>).add = async (
    _n: string,
    _d: unknown,
    opts: { jobId: string },
  ) => {
    if (faults.enqueueRejects) throw new Error('simulated enqueue failure');
    return { id: opts.jobId };
  };
  logger.warn = ((_fields: unknown, msg: string) => {
    warnings.push(msg);
  }) as unknown as typeof logger.warn;
  resetMetrics();
  try {
    await handlers.get(type)!(envelopeFor({ type, data }));
  } finally {
    (queue as unknown as Record<string, unknown>).add = realAdd;
    logger.warn = realWarn;
  }
  return { warnings };
}

const started = { rideId: RIDE, driverId: 'd' };
const liveCount = (kind: string, labels: Record<string, string>) =>
  value(`notification_live_${kind}`, labels);

describe('live path — the notifications the consumer does not get out', () => {
  it('a delivered notification counts no live failure', async () => {
    await deliver('ride.started', started);
    assert.deepEqual(series('notification_live_'), []);
  });

  it('a failed lookup counts live_lookup_failed by event type', async () => {
    await deliver('ride.started', started, { rideLookupFails: true });
    assert.equal(liveCount('lookup_failed', { event_type: 'ride.started' }), 1);
    assert.equal(series('notification_live_').length, 1);
  });

  it('a failed insert counts live_persist_failed by event type and category', async () => {
    await deliver('ride.started', started, { insertFails: true });
    assert.equal(
      liveCount('persist_failed', { event_type: 'ride.started', category: 'TRANSACTIONAL' }),
      1,
    );
    assert.equal(series('notification_live_').length, 1);
  });

  it('a failed enqueue counts live_enqueue_failed, beside the writer’s own notification_enqueue_failed', async () => {
    await deliver('ride.started', started, { enqueueRejects: true });
    assert.equal(
      liveCount('enqueue_failed', { event_type: 'ride.started', category: 'TRANSACTIONAL' }),
      1,
    );
    assert.equal(
      value('notification_enqueue_failed', {
        event_type: 'ride.started',
        category: 'TRANSACTIONAL',
      }),
      1,
    );
    assert.equal(
      value('notification_live_persist_failed', {
        event_type: 'ride.started',
        category: 'TRANSACTIONAL',
      }),
      0,
    );
  });

  it('a metric that cannot be emitted changes nothing: the failure is still isolated and logged', async () => {
    const realInfo = logger.info;
    logger.info = (() => {
      throw new Error('log sink down');
    }) as unknown as typeof logger.info;
    try {
      const { warnings } = await deliver('ride.started', started, { insertFails: true });
      assert.deepEqual(warnings, ['[rides] failed to process push notification']);
    } finally {
      logger.info = realInfo;
    }
  });

  it('labels every live failure with the event type and delivery class only — never an id', async () => {
    for (const faults of [
      { rideLookupFails: true },
      { insertFails: true },
      { enqueueRejects: true },
    ]) {
      await deliver('ride.started', started, faults);
      for (const sample of series('notification_live_')) {
        for (const [key, label] of Object.entries(sample.labels)) {
          assert.ok(['event_type', 'category'].includes(key), `${sample.name}: ${key}`);
          assert.doesNotMatch(label, UUID, `${sample.name}.${key}`);
          assert.ok(
            (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(label) ||
              ['TRANSACTIONAL', 'RIDE_OFFER'].includes(label),
            `${sample.name}.${key}=${label}`,
          );
        }
      }
    }
    assert.ok(
      !Object.values({ CUSTOMER_USER }).some((id) =>
        JSON.stringify(snapshotMetrics()).includes(id),
      ),
    );
  });
});
