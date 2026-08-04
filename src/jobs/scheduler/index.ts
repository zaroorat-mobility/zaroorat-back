import { fileConfig } from '@config/file/file.config.js';
import { userConfig } from '@config/user';
import { logger } from '@shared/logger/index.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  maintenanceQueue,
  type JobName,
  type QueueName,
} from '../queues/index.js';

/**
 * The timezone every cron pattern below is interpreted in.
 *
 * Pinned rather than left to the host. BullMQ resolves a cron pattern against
 * the process's local time, which makes "daily 03:00" mean 03:00 UTC on a
 * cluster node and 03:00 IST on a developer laptop — a four-and-a-half-hour
 * difference that nothing in the code or the schedule would reveal. Volume 08
 * §27 requires schedule arithmetic in UTC, so UTC is what this pins.
 *
 * Files doc 09 §4.2 says "daily 03:00" without naming a zone; that ambiguity is
 * reported rather than guessed at silently, and 03:00 UTC is 08:30 IST — inside
 * the Indian morning peak, not the quiet window "03:00" implies. Whoever wants
 * the quiet window sets `FILE_RETENTION_CRON` to `30 21 * * *` or changes this
 * constant; either way the schedule now means one thing everywhere it runs.
 */
export const SCHEDULE_TIMEZONE = 'Etc/UTC';

/** One recurring job: which queue, under what name, on what cron. */
export interface JobSchedule {
  /** The queue the job is produced onto. */
  queue: QueueName;
  /** The job name the worker dispatches on. */
  name: JobName;
  /** A five-field cron pattern, interpreted in {@link SCHEDULE_TIMEZONE}. */
  pattern: string;
}

/**
 * Every recurring job in the application, in one place (volume 08 §28).
 *
 * A table rather than scattered `upsertJobScheduler` calls, so "what runs on a
 * clock, and when?" is answered by reading one array instead of grepping the
 * codebase — and so a unit test can assert every entry has a handler.
 */
export const JOB_SCHEDULES: readonly JobSchedule[] = Object.freeze([
  {
    queue: QUEUE_NAMES.FILES_MAINTENANCE,
    name: JOB_NAMES.FILE_SWEEP,
    pattern: fileConfig.sweeperCron,
  },
  {
    queue: QUEUE_NAMES.FILES_MAINTENANCE,
    name: JOB_NAMES.FILE_RETENTION,
    pattern: fileConfig.retentionCron,
  },
  {
    // Half an hour after FILES' retention, not alongside it. Both erase, and
    // account erasure hands its avatar to FILES — running them together would
    // have one job's output land after the other job had already scanned for it.
    queue: QUEUE_NAMES.USERS_MAINTENANCE,
    name: JOB_NAMES.ACCOUNT_ERASURE,
    pattern: userConfig.erasureCron,
  },
]);

/**
 * Install (or update) every schedule in {@link JOB_SCHEDULES}.
 *
 * **Idempotent across replicas** (volume 08 §28), which is the property that
 * matters: every worker pod runs this at startup, and a scheduler keyed by job
 * name is upserted rather than appended — so ten replicas produce one schedule,
 * and changing a cron pattern in config takes effect on the next deploy instead
 * of leaving the old schedule running alongside the new one.
 */
export async function registerJobSchedules(): Promise<void> {
  for (const schedule of JOB_SCHEDULES) {
    const queue = maintenanceQueue(schedule.queue);
    await queue.upsertJobScheduler(
      schedule.name,
      { pattern: schedule.pattern, tz: SCHEDULE_TIMEZONE },
      { name: schedule.name },
    );
    logger.info(
      { queue: schedule.queue, job: schedule.name, pattern: schedule.pattern },
      'Job schedule registered',
    );
  }
}
