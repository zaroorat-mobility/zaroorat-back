import { Worker, type Job } from 'bullmq';

import { logger } from '@shared/logger/index.js';
import type { RetentionResult, SweepResult } from '@modules/files';
import type { ErasureResult } from '@modules/users';
import type { AuthRetentionResult } from '@modules/auth';
import type { ReconciliationReport } from '@modules/payments';
import { container } from '../../core/di.js';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  createQueueConnection,
  type JobName,
  type QueueName,
} from '../queues/index.js';

export type MaintenanceResult =
  | SweepResult
  | RetentionResult
  | ErasureResult
  | AuthRetentionResult
  | ReconciliationReport
  | number;

export interface MaintenanceRunner {
  run(now: Date): Promise<MaintenanceResult>;
}

export interface JobResolver {
  resolve<T>(registration: string): T;
}

export const MAINTENANCE_HANDLERS: Readonly<Record<JobName, string>> = Object.freeze({
  [JOB_NAMES.FILE_SWEEP]: 'fileSweeperJob',
  [JOB_NAMES.FILE_RETENTION]: 'fileRetentionJob',
  [JOB_NAMES.ACCOUNT_ERASURE]: 'accountErasureJob',
  [JOB_NAMES.AUTH_RETENTION]: 'authRetentionJob',
  [JOB_NAMES.DISPATCH_TIMEOUT]: 'dispatchTimeoutJob',
  [JOB_NAMES.REQUEST_EXPIRY]: 'requestExpiryJob',
  [JOB_NAMES.DRIVER_HEARTBEAT_TIMEOUT]: 'heartbeatTimeoutJob',
  [JOB_NAMES.DRIVER_DOC_EXPIRATION]: 'docExpirationJob',
  [JOB_NAMES.PAYMENT_RECONCILIATION]: 'reconciliationJob',
});

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

export function startMaintenanceWorkers(): Worker<unknown, MaintenanceResult>[] {
  return Object.values(QUEUE_NAMES).map(startMaintenanceWorker);
}
