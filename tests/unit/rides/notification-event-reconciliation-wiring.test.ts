import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { container } from '../../../src/core/di.js';
import { resetMetrics, snapshotMetrics } from '../../../src/core/metrics/index.js';
import { JOB_NAMES } from '../../../src/jobs/queues/index.js';
import { JOB_SCHEDULES } from '../../../src/jobs/scheduler/index.js';
import { MAINTENANCE_HANDLERS } from '../../../src/jobs/workers/index.js';
import * as notificationMetrics from '../../../src/modules/notifications/metrics/notification.metrics.js';
import type { RedisService } from '../../../src/core/cache/RedisService.js';
import type { DatabaseService } from '../../../src/core/database/DatabaseService.js';
import type { OutboxRepository } from '../../../src/core/events/OutboxRepository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import { NotificationEventReconciliationJob } from '../../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S8 — the reconciliation job's contract with the scheduler, the maintenance
/// worker and the DI container, pinned before anything wires it in (S9).
///
/// What the code actually does, which these tests hold it to:
/// - `worker.bootstrap` → `registerJobSchedules` upserts one BullMQ job scheduler
///   per `JOB_SCHEDULES` entry, keyed by job name; only the worker process does.
/// - the maintenance worker runs `container.resolve(MAINTENANCE_HANDLERS[name])
///   .run(now)` — one argument, no options — so the job's mode comes from the
///   environment on that path.
/// - the container is CLASSIC: dependencies are resolved by constructor
///   parameter name.
/// S9 wired it: one registration, one handler, one schedule, imported only
/// through its module's jobs index. What it does is still set by the mode.

const MODE_ENV = 'NOTIFICATION_EVENT_RECONCILIATION_MODE';
const JOB_FILE = 'notification-event-reconciliation.job';

/// A dependency that fails the test the moment anything touches it.
function untouchable<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`${name}.${String(property)} must not be touched`);
      },
    },
  ) as T;
}

function withMode<T>(mode: string | undefined, work: () => Promise<T>): Promise<T> {
  const saved = process.env[MODE_ENV];
  if (mode === undefined) delete process.env[MODE_ENV];
  else process.env[MODE_ENV] = mode;
  return work().finally(() => {
    if (saved === undefined) delete process.env[MODE_ENV];
    else process.env[MODE_ENV] = saved;
  });
}

function reconciliationSamples() {
  return snapshotMetrics().filter((s) => s.name.startsWith('notification_event_reconciliation_'));
}

afterEach(() => {
  resetMetrics();
});

describe('S8 · the reconciliation job’s wiring contract', () => {
  it('is built by the existing CLASSIC container from registered dependencies', () => {
    const job = container.build(NotificationEventReconciliationJob);
    assert.ok(job instanceof NotificationEventReconciliationJob);
    const injected = job as unknown as Record<string, unknown>;
    assert.strictEqual(injected.outboxRepository, container.resolve('outboxRepository'));
    assert.strictEqual(
      injected.notificationRepository,
      container.resolve('notificationRepository'),
    );
    assert.strictEqual(injected.db, container.resolve('databaseService'));
    assert.strictEqual(injected.redis, container.resolve('redisService'));
  });

  // S9: flipped from "not registered, handled, scheduled or imported".
  it('is registered, handled and scheduled exactly once, and imported only by its jobs index', () => {
    assert.equal(container.hasRegistration('notificationEventReconciliationJob'), true);
    assert.equal(
      (Object.values(JOB_NAMES) as string[]).filter(
        (n) => n === 'notification-event-reconciliation',
      ).length,
      1,
    );
    assert.equal(
      Object.values(MAINTENANCE_HANDLERS).filter((h) => h === 'notificationEventReconciliationJob')
        .length,
      1,
    );
    assert.equal(JOB_SCHEDULES.filter((s) => s.name.includes('event-reconciliation')).length, 1);

    const src = path.join(process.cwd(), 'src');
    const importers = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && !file.includes(JOB_FILE))
      .filter((file) => readFileSync(path.join(src, file), 'utf8').includes(JOB_FILE))
      .map((file) => file.split(path.sep).join('/'));
    assert.deepEqual(importers, ['modules/rides/jobs/index.ts']);
  });

  it('leaves the schedules as they were: every name once, PA-11 once on its own queue', () => {
    const names = JOB_SCHEDULES.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, 'no schedule registered twice');
    const pa11 = JOB_SCHEDULES.filter((s) => s.name === JOB_NAMES.NOTIFICATION_RECONCILIATION);
    assert.equal(pa11.length, 1);
    assert.equal(pa11[0]?.queue, 'notifications-maintenance');
    assert.equal(
      MAINTENANCE_HANDLERS[JOB_NAMES.NOTIFICATION_RECONCILIATION],
      'notificationReconciliationJob',
    );
  });

  it('called as the worker calls a job — run(now), no options — while off, it touches nothing', async () => {
    const job = new NotificationEventReconciliationJob(
      untouchable<OutboxRepository>('outboxRepository'),
      untouchable<NotificationRepository>('notificationRepository'),
      untouchable<DatabaseService>('db'),
      untouchable<RedisService>('redis'),
    );
    const report = await withMode('off', () => job.run(new Date()));
    assert.equal(report.ran, false);
    assert.equal(report.mode, 'off');
    assert.deepEqual(
      reconciliationSamples().map((s) => [s.name, s.labels]),
      [['notification_event_reconciliation_runs', { result: 'off', scope: 'off' }]],
    );
  });

  it('an unrecognised mode is off, through the same call', async () => {
    const job = new NotificationEventReconciliationJob(
      untouchable<OutboxRepository>('outboxRepository'),
      untouchable<NotificationRepository>('notificationRepository'),
      untouchable<DatabaseService>('db'),
      untouchable<RedisService>('redis'),
    );
    const report = await withMode('ON', () => job.run(new Date()));
    assert.equal(report.mode, 'off');
    assert.equal(report.ran, false);
  });

  it('with the mode unset, the same call is a dry run — its first act is to take the lock', async () => {
    const job = new NotificationEventReconciliationJob(
      untouchable<OutboxRepository>('outboxRepository'),
      untouchable<NotificationRepository>('notificationRepository'),
      untouchable<DatabaseService>('db'),
      { lock: { acquire: async () => null } } as unknown as RedisService,
    );
    const report = await withMode(undefined, () => job.run(new Date()));
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.aborted, 'lock_held');
    assert.equal(report.ran, false);
  });

  it('keeps every existing notification metric, beside the F3 ones', () => {
    for (const name of [
      'notificationCreated',
      'notificationEnqueueFailed',
      'notificationNoActiveDevice',
      'notificationReconciliationScanned',
      'notificationReconciliationReenqueued',
      'notificationReconciliationSkippedActive',
      'notificationReconciliationExpired',
      'notificationReconciliationSettled',
      'notificationReconciliationError',
      'notificationEventReconciliationCount',
      'notificationEventReconciliationGauge',
      'notificationLiveFailure',
    ]) {
      assert.equal(typeof (notificationMetrics as Record<string, unknown>)[name], 'function', name);
    }
  });
});
