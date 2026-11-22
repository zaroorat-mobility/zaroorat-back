import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { container } from '../../../src/core/di.js';
import { JOB_NAMES, MAINTENANCE_JOB_OPTIONS, QUEUE_NAMES } from '../../../src/jobs/queues/index.js';
import { JOB_SCHEDULES, SCHEDULE_TIMEZONE } from '../../../src/jobs/scheduler/index.js';
import {
  MAINTENANCE_HANDLERS,
  runMaintenanceJob,
  type JobResolver,
  type MaintenanceResult,
} from '../../../src/jobs/workers/index.js';
import { fileConfig } from '../../../src/config/file/file.config.js';

const CRON_PATTERN = /^(\S+\s+){4}\S+$/;

const EMPTY_SWEEP: MaintenanceResult = { ran: true, scanned: 0, reclaimed: 0, failed: 0 };

function fakeResolver(runner: { run(now: Date): Promise<MaintenanceResult> }): {
  resolver: JobResolver;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    resolver: {
      resolve<T>(registration: string): T {
        asked.push(registration);
        return runner as T;
      },
    },
  };
}

describe('job schedule and handler agreement', () => {
  it('schedules exactly the jobs the worker can handle', () => {
    const scheduled = JOB_SCHEDULES.map((schedule) => schedule.name).sort();
    const handled = Object.keys(MAINTENANCE_HANDLERS).sort();
    assert.deepEqual(scheduled, handled);
  });

  it('resolves every handler to a live container registration', () => {
    for (const registration of Object.values(MAINTENANCE_HANDLERS)) {
      assert.ok(container.hasRegistration(registration), `${registration} is not registered`);
    }
  });

  it('schedules each job exactly once', () => {
    const names = JOB_SCHEDULES.map((schedule) => schedule.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('puts every schedule on a declared queue', () => {
    const declared = new Set<string>(Object.values(QUEUE_NAMES));
    for (const schedule of JOB_SCHEDULES) {
      assert.ok(declared.has(schedule.queue), `${schedule.queue} is not a declared queue`);
    }
  });
});

describe('schedule patterns', () => {
  it('gives every job a five-field cron pattern', () => {
    for (const schedule of JOB_SCHEDULES) {
      assert.match(schedule.pattern, CRON_PATTERN, schedule.name);
    }
  });

  it('takes its patterns from configuration, not from literals', () => {
    const patterns = Object.fromEntries(
      JOB_SCHEDULES.map((schedule) => [schedule.name, schedule.pattern]),
    );
    assert.equal(patterns[JOB_NAMES.FILE_SWEEP], fileConfig.sweeperCron);
    assert.equal(patterns[JOB_NAMES.FILE_RETENTION], fileConfig.retentionCron);
  });

  it('pins a timezone rather than inheriting the host clock', () => {
    assert.equal(SCHEDULE_TIMEZONE, 'Etc/UTC');
  });

  it('keeps the documented defaults', () => {
    assert.equal(fileConfig.sweeperCron, '*/15 * * * *');
    assert.equal(fileConfig.retentionCron, '0 3 * * *');
  });
});

describe('queue configuration', () => {
  it('names queues in domain-prefixed kebab-case (§16)', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      assert.match(name, /^[a-z]+(-[a-z]+)+$/, name);
    }
  });

  it('bounds job history in both directions (§18)', () => {
    assert.deepEqual(MAINTENANCE_JOB_OPTIONS.removeOnComplete, { count: 100 });
    assert.deepEqual(MAINTENANCE_JOB_OPTIONS.removeOnFail, { count: 500 });
  });

  it('does not retry a batch scan at the queue level', () => {
    assert.equal(MAINTENANCE_JOB_OPTIONS.attempts, 1);
  });
});

describe('runMaintenanceJob', () => {
  it('dispatches a job name to its registered handler', async () => {
    const { resolver, asked } = fakeResolver({ run: async () => EMPTY_SWEEP });

    await runMaintenanceJob(JOB_NAMES.FILE_SWEEP, resolver);

    assert.deepEqual(asked, ['fileSweeperJob']);
  });

  it('dispatches retention to the retention job, not the sweeper', async () => {
    const { resolver, asked } = fakeResolver({ run: async () => EMPTY_SWEEP });

    await runMaintenanceJob(JOB_NAMES.FILE_RETENTION, resolver);

    assert.deepEqual(asked, ['fileRetentionJob']);
  });

  it('passes the supplied clock through', async () => {
    const now = new Date('2026-08-04T03:00:00.000Z');
    let seen: Date | null = null;
    const { resolver } = fakeResolver({
      run: async (at: Date) => {
        seen = at;
        return EMPTY_SWEEP;
      },
    });

    await runMaintenanceJob(JOB_NAMES.FILE_SWEEP, resolver, now);

    assert.equal(seen, now);
  });

  it('returns the job result so BullMQ records it', async () => {
    const result: MaintenanceResult = { ran: true, scanned: 7, reclaimed: 5, failed: 2 };
    const { resolver } = fakeResolver({ run: async () => result });

    assert.deepEqual(await runMaintenanceJob(JOB_NAMES.FILE_SWEEP, resolver), result);
  });

  it('throws on a job name with no handler', async () => {
    const { resolver } = fakeResolver({ run: async () => EMPTY_SWEEP });

    await assert.rejects(() => runMaintenanceJob('file-vacuum', resolver), /No handler registered/);
  });

  it('does not resolve anything for an unknown job', async () => {
    const { resolver, asked } = fakeResolver({ run: async () => EMPTY_SWEEP });

    await assert.rejects(() => runMaintenanceJob('', resolver));

    assert.deepEqual(asked, []);
  });

  it('propagates a handler failure rather than swallowing it', async () => {
    const { resolver } = fakeResolver({
      run: () => Promise.reject(new Error('storage unreachable')),
    });

    await assert.rejects(
      () => runMaintenanceJob(JOB_NAMES.FILE_RETENTION, resolver),
      /storage unreachable/,
    );
  });
});
