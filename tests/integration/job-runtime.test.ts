import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Worker } from 'bullmq';

import { bootApp, resetState } from './helpers/harness.js';
import { fileConfig } from '../../src/config/file/file.config.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  closeQueues,
  filesMaintenanceQueue,
} from '../../src/jobs/queues/index.js';
import { SCHEDULE_TIMEZONE, registerJobSchedules } from '../../src/jobs/scheduler/index.js';
import {
  startFilesMaintenanceWorker,
  type MaintenanceResult,
} from '../../src/jobs/workers/index.js';
import type { SweepResult } from '../../src/modules/files/jobs/sweeper.job.js';

/** Give a real worker room to connect, pull, and run; far above observed timings. */
const JOB_TIMEOUT_MS = 15_000;

/**
 * Wait for the worker to finish one job by name.
 * @param worker The running worker.
 * @param name The job name to wait for.
 * @returns The job's result.
 */
function nextResult(worker: Worker, name: string): Promise<MaintenanceResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), 10_000);
    worker.on('completed', (job, result: MaintenanceResult) => {
      if (job.name !== name) return;
      clearTimeout(timer);
      resolve(result);
    });
    worker.on('failed', (job, err) => {
      if (job?.name !== name) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * The job runtime (handbook volume 08), against the real Redis the tests use.
 *
 * This is the gap files doc 01 §13.4 named: the sweeper and retention jobs were
 * complete and tested, and nothing called them. What is proved here is only the
 * calling — that a schedule survives being registered twice, and that a job put
 * on the queue reaches the service that performs it. What each job *does* stays
 * covered by `file-jobs.test.ts`, which invokes them directly and does not need
 * a queue to do it.
 */
describe('job runtime (integration)', () => {
  let app: FastifyInstance;
  let worker: Worker;

  before(async () => {
    app = await bootApp();
    // A flush would take BullMQ's keys with it mid-run; reset once, up front.
    await resetState();
    await filesMaintenanceQueue().obliterate({ force: true });
  });

  after(async () => {
    await worker?.close();
    await filesMaintenanceQueue().obliterate({ force: true });
    await closeQueues();
    await app.close();
  });

  describe('schedule registration', () => {
    it('installs one scheduler per declared job', async () => {
      await registerJobSchedules();

      const schedulers = await filesMaintenanceQueue().getJobSchedulers();
      assert.deepEqual(
        schedulers.map((scheduler) => scheduler.key).sort(),
        [JOB_NAMES.FILE_RETENTION, JOB_NAMES.FILE_SWEEP].sort(),
      );
    });

    it('is idempotent across replicas', async () => {
      // Every worker pod runs this at startup. Three replicas must not mean
      // three sweeps every fifteen minutes (volume 08 §28).
      await registerJobSchedules();
      await registerJobSchedules();

      assert.equal(await filesMaintenanceQueue().getJobSchedulersCount(), 2);
    });

    it('stores the configured pattern and the pinned timezone', async () => {
      await registerJobSchedules();

      const schedulers = await filesMaintenanceQueue().getJobSchedulers();
      const sweep = schedulers.find((scheduler) => scheduler.key === JOB_NAMES.FILE_SWEEP);
      const retention = schedulers.find((scheduler) => scheduler.key === JOB_NAMES.FILE_RETENTION);

      assert.equal(sweep?.pattern, fileConfig.sweeperCron);
      assert.equal(retention?.pattern, fileConfig.retentionCron);
      assert.equal(sweep?.tz, SCHEDULE_TIMEZONE);
      assert.equal(retention?.tz, SCHEDULE_TIMEZONE);
    });

    it('schedules a next run rather than leaving the job undated', async () => {
      await registerJobSchedules();

      const schedulers = await filesMaintenanceQueue().getJobSchedulers();
      for (const scheduler of schedulers) {
        assert.ok(scheduler.next, `${scheduler.key} has no next run`);
        assert.ok(scheduler.next > Date.now(), `${scheduler.key} is scheduled in the past`);
      }
    });

    it('re-points an existing schedule instead of adding a second one', async () => {
      const queue = filesMaintenanceQueue();
      await queue.upsertJobScheduler(
        JOB_NAMES.FILE_SWEEP,
        { pattern: '0 0 1 1 *', tz: SCHEDULE_TIMEZONE },
        { name: JOB_NAMES.FILE_SWEEP },
      );

      await registerJobSchedules();

      const schedulers = await queue.getJobSchedulers();
      const sweep = schedulers.find((scheduler) => scheduler.key === JOB_NAMES.FILE_SWEEP);
      assert.equal(schedulers.length, 2);
      assert.equal(sweep?.pattern, fileConfig.sweeperCron);
    });
  });

  describe('worker dispatch', () => {
    before(async () => {
      // Tear the schedules down before a worker exists to consume them: a run
      // that starts at :14 would otherwise race a real `*/15` sweep and see
      // someone else's result.
      const queue = filesMaintenanceQueue();
      for (const scheduler of await queue.getJobSchedulers()) {
        await queue.removeJobScheduler(scheduler.key);
      }
      await queue.obliterate({ force: true });

      worker = startFilesMaintenanceWorker();
    });

    it(
      'runs a queued sweep through to the sweeper service',
      { timeout: JOB_TIMEOUT_MS },
      async () => {
        const pending = nextResult(worker, JOB_NAMES.FILE_SWEEP);
        await filesMaintenanceQueue().add(JOB_NAMES.FILE_SWEEP, {});

        const result = (await pending) as SweepResult;

        // An empty `files` table: nothing to reclaim, and the lock was free.
        assert.equal(result.ran, true);
        assert.equal(result.scanned, 0);
        assert.equal(result.failed, 0);
      },
    );

    it(
      'runs a queued retention pass through to the retention service',
      { timeout: JOB_TIMEOUT_MS },
      async () => {
        const pending = nextResult(worker, JOB_NAMES.FILE_RETENTION);
        await filesMaintenanceQueue().add(JOB_NAMES.FILE_RETENTION, {});

        assert.deepEqual(await pending, {
          scanned: 0,
          archived: 0,
          erased: 0,
          blocked: 0,
          unclaimed: 0,
          failed: 0,
        });
      },
    );

    it('fails a job whose name no handler claims', { timeout: JOB_TIMEOUT_MS }, async () => {
      const pending = nextResult(worker, 'file-vacuum');
      await filesMaintenanceQueue().add('file-vacuum', {});

      await assert.rejects(() => pending, /No handler registered/);
    });

    it('records the result on the completed job', { timeout: JOB_TIMEOUT_MS }, async () => {
      // `removeOnComplete: { count: 100 }` keeps recent history, which is what
      // makes "did the 03:00 run do anything?" answerable without a log search.
      const pending = nextResult(worker, JOB_NAMES.FILE_SWEEP);
      const job = await filesMaintenanceQueue().add(JOB_NAMES.FILE_SWEEP, {});
      await pending;

      const stored = await filesMaintenanceQueue().getJob(job.id!);
      assert.equal(stored?.returnvalue.ran, true);
    });

    it('is attached to the queue the schedules target', () => {
      assert.equal(worker.name, QUEUE_NAMES.FILES_MAINTENANCE);
    });
  });
});
