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
    queue: QUEUE_NAMES.RIDES_MAINTENANCE,
    name: JOB_NAMES.SCHEDULED_RIDE_REMINDER,
    pattern: process.env.SCHEDULED_RIDE_REMINDER_CRON ?? '* * * * *',
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
    name: JOB_NAMES.PAYMENT_INTENT_RECONCILIATION,
    // Every ten minutes: a stale PENDING/PROCESSING PaymentIntent is only
    // reconciled once it has sat for STALE_AFTER_MS (15 minutes) anyway, so
    // this does not need to run as often as the wallet-balance reconciliation.
    pattern: process.env.PAYMENT_INTENT_RECONCILIATION_CRON ?? '*/10 * * * *',
  },
  {
    queue: QUEUE_NAMES.PAYMENTS_MAINTENANCE,
    name: JOB_NAMES.REFUND_RECONCILIATION,
    // A refund with an unknown provider outcome stays PROCESSING; this asks the
    // provider again (same reference, never a second refund) after 5 minutes.
    pattern: process.env.REFUND_RECONCILIATION_CRON ?? '*/5 * * * *',
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
  {
    queue: QUEUE_NAMES.PAYMENTS_MAINTENANCE,
    name: JOB_NAMES.REFERRAL_PENDING_REWARD_SWEEP,
    // Hourly. A reward is credited in the same transaction that creates it, so
    // anything still PENDING is already wrong — this only decides how long it
    // stays unnoticed, and hourly is frequent enough for a condition that should
    // never occur at all.
    pattern: process.env.REFERRAL_PENDING_REWARD_SWEEP_CRON ?? '20 * * * *',
  },
  {
    queue: QUEUE_NAMES.SUBSCRIPTIONS_MAINTENANCE,
    name: JOB_NAMES.SUBSCRIPTION_EXPIRY,
    // Every five minutes: expiry gates whether a subscription driver can
    // accept new rides, so this shouldn't lag a paid period's end by much.
    pattern: process.env.SUBSCRIPTION_EXPIRY_CRON ?? '*/5 * * * *',
  },
  {
    queue: QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE,
    name: JOB_NAMES.NOTIFICATION_RECONCILIATION,
    // Every minute, the finest a cron pattern allows. A notification whose
    // enqueue failed is only a candidate once it is 30s old, so it is picked up
    // 30–90s after it was stranded — well inside every non-offer delivery TTL
    // (shortest: 10 minutes). Each sweep is bounded to 100 notifications.
    pattern: process.env.NOTIFICATION_RECONCILIATION_CRON ?? '* * * * *',
  },
  {
    queue: QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE,
    name: JOB_NAMES.NOTIFICATION_EVENT_RECONCILIATION,
    // F3 outbox reconciliation: writes the notifications whose event was
    // published but never produced a row. Every minute; an event is a candidate
    // 60s after publication. What it does is set by
    // NOTIFICATION_EVENT_RECONCILIATION_MODE (unset = dry-run, `off` = nothing).
    //
    // Rollback: a BullMQ scheduler outlives this entry. Removing it from the
    // code leaves the scheduler firing a job no handler claims, failing every
    // minute — also run removeJobScheduler('notification-event-reconciliation')
    // on notifications-maintenance (docs/14_Operations/02_runbooks.md, RB-09).
    pattern: process.env.NOTIFICATION_EVENT_RECONCILIATION_CRON ?? '* * * * *',
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
