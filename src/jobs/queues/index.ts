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
  AUTH_OTP: 'auth-otp',
} as const);
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
export const JOB_NAMES = Object.freeze({
  FILE_SWEEP: 'file-sweep',
  FILE_RETENTION: 'file-retention',
  ACCOUNT_ERASURE: 'account-erasure',
  AUTH_RETENTION: 'auth-retention',
  DISPATCH_TIMEOUT: 'dispatch-timeout',
  REQUEST_EXPIRY: 'request-expiry',
  DRIVER_HEARTBEAT_TIMEOUT: 'driver-heartbeat-timeout',
  DRIVER_DOC_EXPIRATION: 'driver-doc-expiration',
  PAYMENT_RECONCILIATION: 'payment-reconciliation',
  DRIVER_SETTLEMENT: 'driver-settlement',
  OTP_SEND: 'otp-send',
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
export function filesMaintenanceQueue(): Queue {
  return maintenanceQueue(QUEUE_NAMES.FILES_MAINTENANCE);
}
export function usersMaintenanceQueue(): Queue {
  return maintenanceQueue(QUEUE_NAMES.USERS_MAINTENANCE);
}
export async function closeQueues(): Promise<void> {
  const queues = [...open.values()];
  open.clear();
  await Promise.all(queues.map((queue) => queue.close()));
}
