import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  NOTIFICATION_EVENT_TYPES,
  notificationIdempotencyKey,
  planNotifications,
  type NotificationLookups,
  type PlanOutcome,
} from '../../../src/modules/rides/consumers/ride-notification.planner.js';
import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import {
  DRIVERS,
  GOLDEN_SCENARIOS,
  NOTIFICATION_EVENT_TYPES as CONSUMER_SUBSCRIPTIONS,
  OUTCOMES_BY_ID,
  RIDE,
  RIDES,
  envelopeFor,
  expectedOutcomes,
  type GoldenFaults,
  type GoldenOutcome,
  type GoldenScenario,
} from './ride-notification.golden.js';

/// F3 parity (S3). Drives `planNotifications` directly through every golden
/// scenario the consumer was pinned against, with the same lookup data and the
/// same lookup faults, and requires the same reads, the same recipients in the
/// same order, and — for every notification — exactly the row the consumer
/// inserted, with the priority and delivery class it enqueued with.
///
/// Writer-side faults in the table (insert failure, duplicate, enqueue failure)
/// do not reach a plan: the planner still plans those notifications.

const RIDE_LOOKUP_FAILURE = 'simulated ride lookup failure';
const DRIVER_LOOKUP_FAILURE = 'simulated driver lookup failure';

interface PlannerRun {
  outcomes: PlanOutcome[];
  rideLookups: string[];
  driverLookups: string[];
}

/// The consumer harness's lookups, as `NotificationLookups`: same data, same
/// call-numbered faults.
async function plan(
  scenario: Pick<GoldenScenario, 'type' | 'data'> & { faults?: GoldenFaults },
): Promise<PlannerRun> {
  const faults = scenario.faults ?? {};
  const rideLookups: string[] = [];
  const driverLookups: string[] = [];
  const lookups: NotificationLookups = {
    async findRide(id) {
      rideLookups.push(id);
      if (faults.rideLookupFailsOnCall?.includes(rideLookups.length)) {
        throw new Error(RIDE_LOOKUP_FAILURE);
      }
      const ride = RIDES[id];
      return ride ? { ...ride } : null;
    },
    async findDriver(id) {
      driverLookups.push(id);
      if (faults.driverLookupFails) throw new Error(DRIVER_LOOKUP_FAILURE);
      const driver = DRIVERS[id];
      return driver ? { ...driver } : null;
    },
  };
  const outcomes = await planNotifications(envelopeFor(scenario), lookups);
  return { outcomes, rideLookups, driverLookups };
}

function shape(outcome: PlanOutcome): GoldenOutcome {
  switch (outcome.kind) {
    case 'notify':
      return {
        kind: 'notify',
        audience: outcome.plan.audience,
        deliveryClass: outcome.plan.deliveryClass,
        bullMqPriority: outcome.plan.bullMqPriority,
      };
    case 'skip':
      return { kind: 'skip', audience: outcome.audience, reason: outcome.reason };
    case 'lookup_failed':
      return { kind: 'lookup_failed', audience: outcome.audience };
  }
}

/// Everything a plan decides, in a form two runs can be compared by.
function comparable(outcomes: PlanOutcome[]): unknown[] {
  return outcomes.map((outcome) =>
    outcome.kind === 'lookup_failed'
      ? { ...shape(outcome), error: (outcome.error as Error).message }
      : outcome,
  );
}

async function planAll(): Promise<unknown[]> {
  const all: unknown[] = [];
  for (const scenario of GOLDEN_SCENARIOS) all.push(comparable((await plan(scenario)).outcomes));
  return all;
}

describe('planNotifications — F3 parity with the golden table', () => {
  it('has a planner outcome for every golden scenario, and none for a scenario that no longer exists', () => {
    const ids = new Set(GOLDEN_SCENARIOS.map((scenario) => scenario.id));
    for (const id of Object.keys(OUTCOMES_BY_ID)) assert.ok(ids.has(id), `stale outcome ${id}`);
    for (const scenario of GOLDEN_SCENARIOS) assert.doesNotThrow(() => expectedOutcomes(scenario));
  });

  for (const scenario of GOLDEN_SCENARIOS) {
    it(`${scenario.id} · ${scenario.name}`, async () => {
      const { outcomes, rideLookups, driverLookups } = await plan(scenario);
      const { expect } = scenario;

      // Who, in what order, and whether they are told, skipped or failed.
      assert.deepStrictEqual(outcomes.map(shape), expectedOutcomes(scenario), 'outcomes');

      // The same reads, in the same order, as the consumer made.
      assert.deepStrictEqual(rideLookups, expect.rideLookups, 'ride lookups');
      assert.deepStrictEqual(driverLookups, expect.driverLookups, 'driver lookups');

      // Every plan is exactly the row the consumer inserted: recipient, copy,
      // payload, Prisma priority, idempotency key, reference.
      const plans = outcomes.flatMap((outcome) =>
        outcome.kind === 'notify' ? [outcome.plan] : [],
      );
      assert.deepStrictEqual(
        plans.map((p) => p.input),
        expect.rows,
        'plans must equal the rows the consumer inserted',
      );

      // …and carries exactly the BullMQ priority and delivery class the
      // consumer enqueued it with. Insert attempt n is enqueued as `notif-n`.
      for (const enqueued of expect.enqueues) {
        const attempt = Number(enqueued.opts.jobId.slice('notif-'.length));
        const matching = plans[attempt - 1];
        assert.ok(matching, `no plan for enqueued ${enqueued.opts.jobId}`);
        assert.equal(matching.bullMqPriority, enqueued.opts.priority, 'BullMQ priority');
        assert.equal(matching.deliveryClass, enqueued.data.category, 'delivery class');
        assert.equal(matching.input.userId, enqueued.data.userId, 'recipient');
        assert.equal(matching.input.referenceId, enqueued.data.rideId, 'ride id');
      }

      // A failed lookup carries the error it failed with, for the caller to log.
      for (const outcome of outcomes) {
        if (outcome.kind !== 'lookup_failed') continue;
        assert.ok(outcome.error instanceof Error);
        assert.ok(
          [RIDE_LOOKUP_FAILURE, DRIVER_LOOKUP_FAILURE].includes(outcome.error.message),
          `unexpected error: ${outcome.error.message}`,
        );
      }
    });
  }
});

describe('planNotifications — contract edges', () => {
  it('handles exactly the ten events the consumer subscribes to', () => {
    assert.deepEqual([...NOTIFICATION_EVENT_TYPES].sort(), [...CONSUMER_SUBSCRIPTIONS].sort());
  });

  it('plans nothing, and reads nothing, for an event outside the ten', async () => {
    for (const type of [
      'ride.requested',
      'ride.dispatch.expired',
      'payment.refund.processed',
      'user.account.erased',
    ]) {
      const run = await plan({ type, data: { rideId: RIDE, customerId: 'x', driverId: 'y' } });
      assert.deepStrictEqual(run, { outcomes: [], rideLookups: [], driverLookups: [] }, type);
    }
  });

  it('rejects when envelope.data is missing, exactly as the consumer does', async () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      await assert.rejects(
        plan({ type, data: null as unknown as Record<string, unknown> }),
        TypeError,
        type,
      );
    }
  });

  it('keys a notification by eventId:type:userId:PUSH', () => {
    const envelope = envelopeFor({ type: 'ride.started', data: {} });
    assert.equal(
      notificationIdempotencyKey(envelope, 'u-1'),
      'e0000000-0000-4000-8000-000000000001:ride.started:u-1:PUSH',
    );
  });
});

describe('planNotifications — no side effects', () => {
  it('imports nothing that can persist, enqueue, log or count', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/modules/rides/consumers/ride-notification.planner.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)].map(
      (match) => ({ typeOnly: match[1] !== undefined, from: match[2] }),
    );
    const valueImports = imports
      .filter((i) => !i.typeOnly)
      .map((i) => i.from)
      .sort();
    assert.deepEqual(valueImports, [
      '../events/catalog.js',
      '@modules/notifications/policies/notification-priority.policy.js',
      '@modules/payments/events/catalog.js',
    ]);
    assert.doesNotMatch(source, /\brequire\(|\bimport\(/, 'no dynamic imports');
  });

  it('emits no metrics', async () => {
    resetMetrics();
    await planAll();
    assert.deepStrictEqual(snapshotMetrics(), []);
  });

  it('does not read the clock: plans are identical at any instant', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const atEpoch = await planAll();
    t.mock.timers.setTime(Date.parse('2099-06-01T00:00:00.000Z'));
    const inTheFuture = await planAll();
    assert.deepStrictEqual(inTheFuture, atEpoch);
  });

  it('does not mutate the envelope it is given', async () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      const envelope = envelopeFor(scenario);
      const before = structuredClone(envelope);
      await planNotifications(envelope, {
        async findRide(id) {
          const ride = RIDES[id];
          return ride ? { ...ride } : null;
        },
        async findDriver(id) {
          const driver = DRIVERS[id];
          return driver ? { ...driver } : null;
        },
      });
      assert.deepStrictEqual(envelope, before, `${scenario.id} ${scenario.type}`);
    }
  });
});
