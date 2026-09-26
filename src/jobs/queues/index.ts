import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@config';
import { otpConfig } from '@config/otp/otp.config.js';
export const QUEUE_NAMES = Object.freeze({
  FILES_MAINTENANCE: 'files-maintenance',
  USERS_MAINTENANCE: 'users-maintenance',
  AUTH_MAINTENANCE: 'auth-maintenance',
  RIDES_MAINTENANCE: 'rides-maintenance',
  DRIVERS_MAINTENANCE: 'drivers-maintenance',
  PAYMENTS_MAINTENANCE: 'payments-maintenance',
  SUBSCRIPTIONS_MAINTENANCE: 'subscriptions-maintenance',
  NOTIFICATIONS_MAINTENANCE: 'notifications-maintenance',
  AUTH_OTP: 'auth-otp',
  NOTIFICATIONS: 'notifications',
} as const);
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export const JOB_NAMES = Object.freeze({
  FILE_SWEEP: 'file-sweep',
  FILE_RETENTION: 'file-retention',
  ACCOUNT_ERASURE: 'account-erasure',
  AUTH_RETENTION: 'auth-retention',
  DISPATCH_TIMEOUT: 'dispatch-timeout',
  REQUEST_EXPIRY: 'request-expiry',
  SCHEDULED_RIDE_REMINDER: 'scheduled-ride-reminder',
  DRIVER_HEARTBEAT_TIMEOUT: 'driver-heartbeat-timeout',
  DRIVER_DOC_EXPIRATION: 'driver-doc-expiration',
  PAYMENT_RECONCILIATION: 'payment-reconciliation',
  PAYMENT_INTENT_RECONCILIATION: 'payment-intent-reconciliation',
  REFUND_RECONCILIATION: 'refund-reconciliation',
  PAYMENT_COLLECTION_SWEEP: 'payment-collection-sweep',
  PAYMENT_RECEIVABLE_WRITEOFF: 'payment-receivable-writeoff',
  DRIVER_SETTLEMENT: 'driver-settlement',
  REFERRAL_PENDING_REWARD_SWEEP: 'referral-pending-reward-sweep',
  SUBSCRIPTION_EXPIRY: 'subscription-expiry',
  OTP_SEND: 'otp-send',
  NOTIFICATION_DELIVERY: 'notification-delivery',
  NOTIFICATION_RECONCILIATION: 'notification-reconciliation',
  NOTIFICATION_EVENT_RECONCILIATION: 'notification-event-reconciliation',
} as const);
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
export function createQueueConnection(): Redis {
  return new Redis(config.redis.url, { maxRetriesPerRequest: null });
}
export const MAINTENANCE_JOB_OPTIONS: JobsOptions = Object.freeze({
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});
export const OTP_JOB_OPTIONS: JobsOptions = Object.freeze({
  attempts: otpConfig.delivery.attempts,
  backoff: { type: 'exponential', delay: otpConfig.delivery.backoffMs },
  removeOnComplete: true,
  removeOnFail: { age: 3600 },
});
export const NOTIFICATION_JOB_OPTIONS: JobsOptions = Object.freeze({
  attempts: 4,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
});
const open = new Map<QueueName, Queue>();
function openQueue(name: QueueName, defaultJobOptions: JobsOptions): Queue {
  let queue = open.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: createQueueConnection(), defaultJobOptions });
    open.set(name, queue);
  }
  return queue;
}
export function maintenanceQueue(name: QueueName): Queue {
  return openQueue(name, MAINTENANCE_JOB_OPTIONS);
}
export function otpQueue(): Queue {
  return openQueue(QUEUE_NAMES.AUTH_OTP, OTP_JOB_OPTIONS);
}
export function notificationsQueue(): Queue {
  return openQueue(QUEUE_NAMES.NOTIFICATIONS, NOTIFICATION_JOB_OPTIONS);
}
export function filesMaintenanceQueue(): Queue {
  return maintenanceQueue(QUEUE_NAMES.FILES_MAINTENANCE);
}
export function usersMaintenanceQueue(): Queue {
  return maintenanceQueue(QUEUE_NAMES.USERS_MAINTENANCE);
}
export function allQueueNames(): QueueName[] {
  return Object.values(QUEUE_NAMES);
}

export function resolveQueue(name: string): Queue | null {
  if (name === QUEUE_NAMES.AUTH_OTP) return otpQueue();
  if (name === QUEUE_NAMES.NOTIFICATIONS) return notificationsQueue();
  if (!(Object.values(QUEUE_NAMES) as string[]).includes(name)) return null;
  return maintenanceQueue(name as QueueName);
}

export function allManagedQueues(): Array<{
  name: QueueName;
  kind: 'maintenance' | 'otp' | 'notifications';
}> {
  return [
    ...Object.values(QUEUE_NAMES).map((name) => ({
      name,
      kind:
        name === QUEUE_NAMES.AUTH_OTP
          ? ('otp' as const)
          : name === QUEUE_NAMES.NOTIFICATIONS
            ? ('notifications' as const)
            : ('maintenance' as const),
    })),
  ];
}

export async function closeQueues(): Promise<void> {
  const queues = [...open.values()];
  open.clear();
  await Promise.all(queues.map((queue) => queue.close()));
}

/// How long the notification enqueue may take before it is abandoned.
///
/// PA-1 SCOPE CORRECTION. `createQueueConnection` sets
/// `maxRetriesPerRequest: null` (jobs/queues/index.ts), which means ioredis
/// queues a command and retries it forever rather than failing it. With Redis
/// unreachable, `queue.add()` therefore never settles — it does not throw, it
/// stays pending. This consumer is awaited by `EventBus.emit`, which is awaited
/// by `OutboxRelay.dispatch`, which walks its claimed batch serially. So one
/// unreachable Redis stalled the entire outbox relay indefinitely, taking the
/// realtime bridge down with it: no socket events for any other event in the
/// batch either.
///
/// Measured before the fix: 37.7s pending on a single `add`, still going when
/// killed.
///
/// Two seconds is chosen to be far longer than a healthy enqueue (sub-millisecond
/// on a local Redis) and far shorter than the relay's 1s tick, so a Redis outage
/// costs one tick of throughput per event instead of all of it. Left as a
/// documented constant rather than configuration: there is no operational reason
/// to tune it, and adding a config surface for it would widen Phase A.
export const ENQUEUE_TIMEOUT_MS = 2000;

export class EnqueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Notification enqueue did not settle within ${timeoutMs}ms. Redis is likely ` +
        'unreachable; the notification stays QUEUED for the reconciliation sweep.',
    );
    this.name = 'EnqueueTimeoutError';
  }
}

/// Rejects with `EnqueueTimeoutError` if `work` has not settled within `timeoutMs`.
///
/// Exported for test: the behaviour that matters — that a never-settling promise
/// stops blocking its caller — cannot be observed through the consumer without a
/// Redis to take away.
///
/// `work` keeps a no-op rejection handler attached for its whole life. Without it,
/// a `queue.add` that rejects *after* losing the race would surface as an
/// unhandled rejection and, under Node's default, take the worker down. The race
/// already attaches handlers, so this is belt and braces — but the failure mode it
/// prevents is a process exit, which is worth one line.
export async function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  work.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EnqueueTimeoutError(timeoutMs)), timeoutMs);
  });
  // Deliberately NOT unref'd. `clearTimeout` in the `finally` below already
  // guarantees the timer cannot outlive the race by more than `timeoutMs`, so
  // unref buys nothing — and it costs correctness: an unref'd timer lets the
  // event loop drain while this promise is still pending, which is a process
  // that exits mid-enqueue in production and a cancelled test in CI.

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
