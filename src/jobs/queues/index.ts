import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';

import { config } from '@config';

/**
 * Queue names — kebab-case, domain-prefixed (handbook volume 08 §16).
 *
 * Declared once and imported by both the producer side (the scheduler) and the
 * consumer side (the worker), because a queue name written as a string literal
 * in two places is a typo away from jobs landing on a queue nothing reads —
 * with no error anywhere, since a BullMQ queue is created by being named (§12).
 */
export const QUEUE_NAMES = Object.freeze({
  FILES_MAINTENANCE: 'files-maintenance',
} as const);

/** A queue this application declares. */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Job names, shared for the same reason as {@link QUEUE_NAMES}.
 *
 * The worker dispatches on these (`src/jobs/workers`), and the schedule table
 * repeats them (`src/jobs/scheduler`); a unit test asserts the two agree.
 */
export const JOB_NAMES = Object.freeze({
  FILE_SWEEP: 'file-sweep',
  FILE_RETENTION: 'file-retention',
} as const);

/** A job this application schedules. */
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * A dedicated Redis connection for BullMQ.
 *
 * Deliberately **not** the shared cache client. BullMQ's blocking primitives
 * require `maxRetriesPerRequest: null`; the application client sets `3` so a
 * cache read fails fast instead of hanging a request behind an unreachable
 * Redis. One setting cannot serve both, and BullMQ overrides it silently if
 * handed a client that disagrees.
 *
 * The Redis **server** is still shared (volume 08 §11/§19) — separation is by
 * key prefix (BullMQ's default `bull:`), which is free, rather than by a second
 * instance, which is operational surface nobody has measured a need for yet.
 *
 * Each caller gets its own socket: BullMQ closes the connection it is given,
 * so a queue and a worker sharing one would take each other down on shutdown.
 * @returns A connection configured for BullMQ's blocking commands.
 */
export function createQueueConnection(): Redis {
  return new Redis(config.redis.url, { maxRetriesPerRequest: null });
}

/**
 * Queue-level defaults for `files-maintenance` (volume 08 §18).
 *
 * `attempts: 1` is a decision, not an oversight. Both jobs are batch scans that
 * already isolate failure per item and already own their retry semantics: the
 * sweeper leaves the row and retries on the next tick (files doc 09 §4.1), and
 * retention counts attempts per file and dead-letters at five (§4.3). A
 * queue-level retry would re-run the whole scan — contending for the same Redis
 * lock, redoing work the next tick redoes anyway, and inflating the per-file
 * attempt counter that retention's compliance alert reads.
 *
 * Both `removeOn*` are bounded counts rather than `false`: job history is
 * useful for the last few runs and is unbounded Redis growth after that.
 */
export const MAINTENANCE_JOB_OPTIONS: JobsOptions = Object.freeze({
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

let filesMaintenance: Queue | null = null;

/**
 * The `files-maintenance` queue, created on first use.
 *
 * One queue, not two, because volume 08 §15 sizes queue count by *distinct*
 * retry/priority/monitoring needs and these two jobs have none: both are
 * low-priority, self-locking, idempotent scans that run on a clock. They are
 * separated at the job-name level, which is where their difference actually is.
 * @returns The shared queue handle.
 */
export function filesMaintenanceQueue(): Queue {
  filesMaintenance ??= new Queue(QUEUE_NAMES.FILES_MAINTENANCE, {
    connection: createQueueConnection(),
    defaultJobOptions: MAINTENANCE_JOB_OPTIONS,
  });
  return filesMaintenance;
}

/**
 * Close every open queue handle and its connection.
 *
 * Idempotent, and safe to call when nothing was ever opened — shutdown paths
 * run on failures too.
 */
export async function closeQueues(): Promise<void> {
  const queue = filesMaintenance;
  filesMaintenance = null;
  if (queue) await queue.close();
}
