import { Worker, type Job } from 'bullmq';

import { logger } from '@shared/logger/index.js';
import type { RetentionResult, SweepResult } from '@modules/files';
import { container } from '../../core/di.js';
import { JOB_NAMES, QUEUE_NAMES, createQueueConnection, type JobName } from '../queues/index.js';

/** What one maintenance run reports back. Stored as the job's return value. */
export type MaintenanceResult = SweepResult | RetentionResult;

/** The shape the worker needs from a scheduled job — the whole contract. */
export interface MaintenanceRunner {
  run(now: Date): Promise<MaintenanceResult>;
}

/** The part of the DI container this module uses, so tests can pass a stub. */
export interface JobResolver {
  resolve<T>(registration: string): T;
}

/**
 * Job name → the container registration that performs it.
 *
 * The indirection is what keeps a processor a thin adapter (volume 08 §32):
 * the worker knows which service to ask, and nothing else. Every entry here
 * must appear in `JOB_SCHEDULES` and vice versa — a unit test asserts it,
 * because the failure mode otherwise is a job that runs forever with no
 * handler, or a handler nothing ever triggers, and neither raises anything.
 */
export const MAINTENANCE_HANDLERS: Readonly<Record<JobName, string>> = Object.freeze({
  [JOB_NAMES.FILE_SWEEP]: 'fileSweeperJob',
  [JOB_NAMES.FILE_RETENTION]: 'fileRetentionJob',
});

/**
 * Run one maintenance job by name.
 *
 * An unknown name **throws** rather than being ignored. It means the schedule
 * and the worker disagree — a half-finished deploy, or a rename applied to one
 * side — and a silently skipped compliance job is exactly the failure that must
 * never be quiet. Failing the job puts it in the queue's failed set, where the
 * dead-letter alert already looks.
 *
 * @param name The BullMQ job name.
 * @param resolver Container to resolve the handler from.
 * @param now Clock, injectable for tests.
 * @returns Whatever the job reports, stored as the job's return value.
 * @throws Error when no handler is registered for `name`.
 */
export async function runMaintenanceJob(
  name: string,
  resolver: JobResolver = container,
  now: Date = new Date(),
): Promise<MaintenanceResult> {
  const registration = (MAINTENANCE_HANDLERS as Record<string, string | undefined>)[name];
  if (!registration) {
    throw new Error(`No handler registered for job "${name}" on ${QUEUE_NAMES.FILES_MAINTENANCE}`);
  }
  return resolver.resolve<MaintenanceRunner>(registration).run(now);
}

/**
 * Start the `files-maintenance` worker.
 *
 * `concurrency: 1` (volume 08 §17): both jobs are singleton batch scans that
 * already take a Redis lock, so a second concurrent run would acquire nothing
 * and return immediately — parallelism here buys no throughput and only makes
 * the metrics harder to read.
 * @returns The running worker, for the shutdown path to close.
 */
export function startFilesMaintenanceWorker(): Worker<unknown, MaintenanceResult> {
  const worker = new Worker<unknown, MaintenanceResult>(
    QUEUE_NAMES.FILES_MAINTENANCE,
    (job: Job<unknown, MaintenanceResult>) => runMaintenanceJob(job.name),
    { connection: createQueueConnection(), concurrency: 1 },
  );

  worker.on('completed', (job, result) => {
    logger.info({ job: job.name, jobId: job.id, result }, 'Maintenance job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ err, job: job?.name, jobId: job?.id }, 'Maintenance job failed');
  });

  return worker;
}
