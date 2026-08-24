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
export const SCHEDULE_TIMEZONE = 'Etc/UTC';
const authRetentionCron = process.env.AUTH_RETENTION_CRON ?? '30 4 * * *';
export interface JobSchedule {
  queue: QueueName;
  name: JobName;
  pattern: string;
}
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
    queue: QUEUE_NAMES.USERS_MAINTENANCE,
    name: JOB_NAMES.ACCOUNT_ERASURE,
    pattern: userConfig.erasureCron,
  },
  {
    queue: QUEUE_NAMES.AUTH_MAINTENANCE,
    name: JOB_NAMES.AUTH_RETENTION,
    pattern: authRetentionCron,
  },
  {
    queue: QUEUE_NAMES.RIDES_MAINTENANCE,
    name: JOB_NAMES.DISPATCH_TIMEOUT,
    pattern: process.env.RIDE_DISPATCH_TIMEOUT_CRON ?? '* * * * *',
  },
  {
    queue: QUEUE_NAMES.RIDES_MAINTENANCE,
    name: JOB_NAMES.REQUEST_EXPIRY,
    pattern: process.env.RIDE_REQUEST_EXPIRY_CRON ?? '* * * * *',
  },
  {
    queue: QUEUE_NAMES.DRIVERS_MAINTENANCE,
    name: JOB_NAMES.DRIVER_HEARTBEAT_TIMEOUT,
    pattern: process.env.DRIVER_HEARTBEAT_CRON ?? '* * * * *',
  },
  {
    queue: QUEUE_NAMES.DRIVERS_MAINTENANCE,
    name: JOB_NAMES.DRIVER_DOC_EXPIRATION,
    pattern: process.env.DRIVER_DOC_EXPIRATION_CRON ?? '0 2 * * *',
  },
  {
    queue: QUEUE_NAMES.PAYMENTS_MAINTENANCE,
    name: JOB_NAMES.PAYMENT_RECONCILIATION,
    pattern: process.env.PAYMENT_RECONCILIATION_CRON ?? '15 * * * *',
  },
  {
    queue: QUEUE_NAMES.PAYMENTS_MAINTENANCE,
    name: JOB_NAMES.PAYMENT_COLLECTION_SWEEP,
    // Every five minutes. The completion consumer already collects the happy
    // path within seconds; this only picks up what it could not finish, and
    // each ride carries its own doubling backoff on top.
    pattern: process.env.PAYMENT_COLLECTION_SWEEP_CRON ?? '*/5 * * * *',
  },
  {
    queue: QUEUE_NAMES.PAYMENTS_MAINTENANCE,
    name: JOB_NAMES.PAYMENT_RECEIVABLE_WRITEOFF,
    // Daily, and deliberately not more often: the thing it measures is how
    // many days a debt has been outstanding.
    pattern: process.env.PAYMENT_RECEIVABLE_WRITEOFF_CRON ?? '45 3 * * *',
  },
  {
    queue: QUEUE_NAMES.PAYMENTS_MAINTENANCE,
    name: JOB_NAMES.DRIVER_SETTLEMENT,
    // Once daily, well after midnight UTC, so the prior full day's rides
    // (the window this job settles) are all in.
    pattern: process.env.DRIVER_SETTLEMENT_CRON ?? '30 2 * * *',
  },
]);
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
