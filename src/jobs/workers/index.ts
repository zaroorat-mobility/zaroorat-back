import { Worker, type Job } from 'bullmq';

import { logger } from '@shared/logger/index.js';
import type { RetentionResult, SweepResult } from '@modules/files';
import type { ErasureResult } from '@modules/users';
import { container } from '../../core/di.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  createQueueConnection,
  type JobName,
  type QueueName,
} from '../queues/index.js';

/** What one maintenance run reports back. Stored as the job's return value. */
export type MaintenanceResult = SweepResult | RetentionResult | ErasureResult;

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
  [JOB_NAMES.ACCOUNT_ERASURE]: 'accountErasureJob',
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
    throw new Error(`No handler registered for job "${name}"`);
  }
  return resolver.resolve<MaintenanceRunner>(registration).run(now);
}

/**
 * Start a worker on one maintenance queue.
 *
 * `concurrency: 1` (volume 08 §17): every job on these queues is a singleton
 * batch scan that already takes a Redis lock, so a second concurrent run would
 * acquire nothing and return immediately — parallelism here buys no throughput
 * and only makes the metrics harder to read.
 *
 * One worker per queue rather than one per process, so a queue can later move to
 * its own deployment (volume 08 §33) by starting a different subset here, with
 * no change to the jobs themselves.
 * @param name The queue to consume.
 * @returns The running worker, for the shutdown path to close.
 */
export function startMaintenanceWorker(name: QueueName): Worker<unknown, MaintenanceResult> {
  const worker = new Worker<unknown, MaintenanceResult>(
    name,
    (job: Job<unknown, MaintenanceResult>) => runMaintenanceJob(job.name),
    { connection: createQueueConnection(), concurrency: 1 },
  );

  worker.on('completed', (job, result) => {
    logger.info({ queue: name, job: job.name, jobId: job.id, result }, 'Maintenance job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ err, queue: name, job: job?.name, jobId: job?.id }, 'Maintenance job failed');
  });

  return worker;
}

/**
 * Start a worker on every declared maintenance queue.
 * @returns The running workers, for the shutdown path to close.
 */
export function startMaintenanceWorkers(): Worker<unknown, MaintenanceResult>[] {
  return Object.values(QUEUE_NAMES).map(startMaintenanceWorker);
}
