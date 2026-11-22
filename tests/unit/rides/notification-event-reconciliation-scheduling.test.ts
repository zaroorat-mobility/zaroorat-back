import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { container } from '../../../src/core/di.js';
import { JOB_NAMES } from '../../../src/jobs/queues/index.js';
import { JOB_SCHEDULES } from '../../../src/jobs/scheduler/index.js';
import { MAINTENANCE_HANDLERS, runMaintenanceJob } from '../../../src/jobs/workers/index.js';
import type { RedisService } from '../../../src/core/cache/RedisService.js';
import type { DatabaseService } from '../../../src/core/database/DatabaseService.js';
import type { OutboxRepository } from '../../../src/core/events/OutboxRepository.js';
import type { NotificationRepository } from '../../../src/modules/notifications/repositories/notification.repository.js';
import {
  NotificationEventReconciliationJob,
  type NotificationEventReconciliationReport,
} from '../../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S9 — the reconciliation job wired into the maintenance infrastructure:
/// one job name, one handler, one DI registration, one schedule on
/// notifications-maintenance beside PA-11. What a run does is still the mode's
/// to decide (unset = dry-run, `off` = nothing). The real scheduler, worker and
/// Redis are exercised in
/// tests/integration/notification-event-reconciliation-scheduling-postgres.test.ts.

const NAME = 'notification-event-reconciliation';
const REGISTRATION = 'notificationEventReconciliationJob';
const MODE_ENV = 'NOTIFICATION_EVENT_RECONCILIATION_MODE';

/// Every schedule and handler as they were before S9 (f268550). S9 adds exactly
/// one of each; nothing else may change.
const SCHEDULES_BEFORE_S9: Record<string, string> = {
  'file-sweep': 'files-maintenance',
  'file-retention': 'files-maintenance',
  'account-erasure': 'users-maintenance',
  'auth-retention': 'auth-maintenance',
  'dispatch-timeout': 'rides-maintenance',
  'request-expiry': 'rides-maintenance',
  'scheduled-ride-reminder': 'rides-maintenance',
  'driver-heartbeat-timeout': 'drivers-maintenance',
  'driver-doc-expiration': 'drivers-maintenance',
  'payment-reconciliation': 'payments-maintenance',
  'payment-intent-reconciliation': 'payments-maintenance',
  'refund-reconciliation': 'payments-maintenance',
  'payment-collection-sweep': 'payments-maintenance',
  'payment-receivable-writeoff': 'payments-maintenance',
  'driver-settlement': 'payments-maintenance',
  'referral-pending-reward-sweep': 'payments-maintenance',
  'subscription-expiry': 'subscriptions-maintenance',
  'notification-reconciliation': 'notifications-maintenance',
};
const HANDLERS_BEFORE_S9: Record<string, string> = {
  'file-sweep': 'fileSweeperJob',
  'file-retention': 'fileRetentionJob',
  'account-erasure': 'accountErasureJob',
  'auth-retention': 'authRetentionJob',
  'dispatch-timeout': 'dispatchTimeoutJob',
  'request-expiry': 'requestExpiryJob',
  'scheduled-ride-reminder': 'scheduledRideReminderJob',
  'driver-heartbeat-timeout': 'heartbeatTimeoutJob',
  'driver-doc-expiration': 'docExpirationJob',
  'payment-reconciliation': 'reconciliationJob',
  'payment-intent-reconciliation': 'paymentIntentReconciliationJob',
  'refund-reconciliation': 'refundReconciliationJob',
  'payment-collection-sweep': 'collectionSweepJob',
  'payment-receivable-writeoff': 'receivableWriteOffJob',
  'driver-settlement': 'settlementJob',
  'referral-pending-reward-sweep': 'referralPendingRewardSweepJob',
  'subscription-expiry': 'subscriptionExpiryJob',
  'notification-reconciliation': 'notificationReconciliationJob',
};

/// The schedule entry as a fresh process computes it: `JOB_SCHEDULES` reads the
/// environment once, at module load.
function scheduleInFreshProcess(cron: string | undefined): unknown {
  const env: NodeJS.ProcessEnv = { ...process.env, APP_ENV: 'test' };
  if (cron === undefined) delete env.NOTIFICATION_EVENT_RECONCILIATION_CRON;
  else env.NOTIFICATION_EVENT_RECONCILIATION_CRON = cron;
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `const m = require('./src/jobs/scheduler/index.ts');` +
        `console.log('RESULT' + JSON.stringify(m.JOB_SCHEDULES.find((s) => s.name === '${NAME}')));` +
        `process.exit(0);`,
    ],
    { env, encoding: 'utf8', cwd: process.cwd() },
  );
  const line = output.split('\n').find((l) => l.startsWith('RESULT'));
  assert.ok(line, output);
  return JSON.parse(line.slice('RESULT'.length));
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

const untouchable = <T>(name: string): T =>
  new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`${name}.${String(property)} must not be touched`);
      },
    },
  ) as T;

describe('S9 · reconciliation wired into the maintenance worker', () => {
  it('DI resolves the registered job, as one singleton', () => {
    const job = container.resolve<NotificationEventReconciliationJob>(REGISTRATION);
    assert.ok(job instanceof NotificationEventReconciliationJob);
    assert.strictEqual(container.resolve(REGISTRATION), job);
  });

  it('the job name maps to exactly that registration', () => {
    assert.equal(JOB_NAMES.NOTIFICATION_EVENT_RECONCILIATION, NAME);
    assert.equal(MAINTENANCE_HANDLERS[JOB_NAMES.NOTIFICATION_EVENT_RECONCILIATION], REGISTRATION);
  });

  it('is scheduled exactly once, on notifications-maintenance beside PA-11', () => {
    const mine = JOB_SCHEDULES.filter((s) => s.name === NAME);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.queue, 'notifications-maintenance');
    const pa11 = JOB_SCHEDULES.filter((s) => s.name === JOB_NAMES.NOTIFICATION_RECONCILIATION);
    assert.equal(pa11.length, 1);
    assert.equal(pa11[0]?.queue, mine[0]?.queue);
    assert.equal(
      mine[0]?.pattern,
      process.env.NOTIFICATION_EVENT_RECONCILIATION_CRON ?? '* * * * *',
    );
  });

  it('takes its cron from NOTIFICATION_EVENT_RECONCILIATION_CRON', () => {
    assert.deepEqual(scheduleInFreshProcess('*/5 * * * *'), {
      queue: 'notifications-maintenance',
      name: NAME,
      pattern: '*/5 * * * *',
    });
  });

  it('runs every minute when no cron is configured', () => {
    assert.deepEqual(scheduleInFreshProcess(undefined), {
      queue: 'notifications-maintenance',
      name: NAME,
      pattern: '* * * * *',
    });
  });

  it('changes no other schedule or handler: exactly one of each is added', () => {
    const schedules = Object.fromEntries(JOB_SCHEDULES.map((s) => [s.name, s.queue]));
    assert.deepEqual(schedules, { ...SCHEDULES_BEFORE_S9, [NAME]: 'notifications-maintenance' });
    assert.deepEqual({ ...MAINTENANCE_HANDLERS }, { ...HANDLERS_BEFORE_S9, [NAME]: REGISTRATION });
  });

  it('through the real runMaintenanceJob path, off does nothing', async () => {
    const report = (await withMode('off', () =>
      runMaintenanceJob(NAME),
    )) as NotificationEventReconciliationReport;
    assert.equal(report.mode, 'off');
    assert.equal(report.ran, false);
  });

  it('through the same path, an unrecognised mode is off', async () => {
    const report = (await withMode('true', () =>
      runMaintenanceJob(NAME),
    )) as NotificationEventReconciliationReport;
    assert.equal(report.mode, 'off');
  });

  it('through the same path, an unset mode is a dry run', async () => {
    const resolved: string[] = [];
    const job = new NotificationEventReconciliationJob(
      untouchable<OutboxRepository>('outboxRepository'),
      untouchable<NotificationRepository>('notificationRepository'),
      untouchable<DatabaseService>('db'),
      { lock: { acquire: async () => null } } as unknown as RedisService,
    );
    const report = (await withMode(undefined, () =>
      runMaintenanceJob(NAME, {
        resolve<T>(registration: string): T {
          resolved.push(registration);
          return job as unknown as T;
        },
      }),
    )) as NotificationEventReconciliationReport;
    assert.deepEqual(resolved, [REGISTRATION]);
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.aborted, 'lock_held');
  });
});
