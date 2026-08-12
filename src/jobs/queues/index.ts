import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';

import { config } from '@config';

export const QUEUE_NAMES = Object.freeze({
  FILES_MAINTENANCE: 'files-maintenance',
  USERS_MAINTENANCE: 'users-maintenance',
  AUTH_MAINTENANCE: 'auth-maintenance',

  RIDES_MAINTENANCE: 'rides-maintenance',
  DRIVERS_MAINTENANCE: 'drivers-maintenance',
  PAYMENTS_MAINTENANCE: 'payments-maintenance',
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

const open = new Map<QueueName, Queue>();

export function maintenanceQueue(name: QueueName): Queue {
  let queue = open.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: createQueueConnection(),
      defaultJobOptions: MAINTENANCE_JOB_OPTIONS,
    });
    open.set(name, queue);
  }
  return queue;
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
