import type { Job } from 'bullmq';
import { DatabaseService } from '@core/database';
import { auditExternalAction, redactSensitive, type AuditActor } from '../audit/index.js';
import { JOB_SCHEDULES } from '@/jobs/scheduler/index.js';
import {
  allManagedQueues,
  QUEUE_NAMES,
  resolveQueue,
  type QueueName,
} from '@/jobs/queues/index.js';
import { JobNotFoundError, QueueNotFoundError } from './jobs.errors.js';

export interface QueueSummaryDto {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface JobSummaryDto {
  id: string;
  name: string;
  queue: string;
  status: string;
  attemptsMade: number;
  timestamp: string | null;
  processedOn: string | null;
  finishedOn: string | null;
  maxAttempts: number | null;
  /// Redacted: provider and queue errors echo what they were sent.
  failedReason: string | null;
  /// Only the fields `SAFE_JOB_DATA_FIELDS` names for this queue; null when it names none.
  data: Record<string, unknown> | null;
}

const MAINTENANCE_FIELDS = ['name'] as const;

/// What the admin job browser may show of a job's payload, per queue — an allowlist. A
/// field not listed is never returned, and a queue not listed returns no data at all.
///
/// `auth-otp` is absent on purpose and must stay absent: its payload is the plaintext OTP
/// and the phone number it is sent to (`OtpDeliveryJobData`). Anyone holding `jobs:read`
/// could otherwise read live codes and sign in as the recipient.
const SAFE_JOB_DATA_FIELDS: Partial<Record<QueueName, readonly string[]>> = {
  [QUEUE_NAMES.NOTIFICATIONS]: [
    'notificationId',
    'deliveryId',
    'category',
    'eventType',
    'eventId',
    'rideId',
  ],
  [QUEUE_NAMES.FILES_MAINTENANCE]: MAINTENANCE_FIELDS,
  [QUEUE_NAMES.USERS_MAINTENANCE]: MAINTENANCE_FIELDS,
  [QUEUE_NAMES.AUTH_MAINTENANCE]: MAINTENANCE_FIELDS,
  [QUEUE_NAMES.RIDES_MAINTENANCE]: MAINTENANCE_FIELDS,
  [QUEUE_NAMES.DRIVERS_MAINTENANCE]: MAINTENANCE_FIELDS,
  [QUEUE_NAMES.PAYMENTS_MAINTENANCE]: MAINTENANCE_FIELDS,
  [QUEUE_NAMES.SUBSCRIPTIONS_MAINTENANCE]: MAINTENANCE_FIELDS,
  [QUEUE_NAMES.NOTIFICATIONS_MAINTENANCE]: MAINTENANCE_FIELDS,
};

function safeJobData(queue: string, data: unknown): Record<string, unknown> | null {
  const fields = SAFE_JOB_DATA_FIELDS[queue as QueueName];
  if (!fields || !data || typeof data !== 'object') return null;
  const source = data as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field];
    // Scalars only: an allowlisted name holding an object would smuggle its contents.
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      picked[field] = value;
    }
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

export interface SchedulerDto {
  id: string;
  queue: string;
  jobName: string;
  pattern: string;
  timezone: string;
  nextRunAt: string | null;
}

function queueOrThrow(name: string) {
  const queue = resolveQueue(name);
  if (!queue) throw new QueueNotFoundError(name);
  return queue;
}

function serializeJob(queue: string, job: Job, status: string): JobSummaryDto {
  return {
    id: String(job.id),
    name: job.name,
    queue,
    status,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    maxAttempts: typeof job.opts?.attempts === 'number' ? job.opts.attempts : null,
    failedReason: job.failedReason ? redactSensitive(job.failedReason).slice(0, 200) : null,
    data: safeJobData(queue, job.data),
  };
}

export class AdminJobsService {
  constructor(private readonly databaseService: DatabaseService) {}

  async listQueues(): Promise<{ data: QueueSummaryDto[] }> {
    const data = await Promise.all(
      allManagedQueues().map(async ({ name }) => {
        const queue = resolveQueue(name);
        if (!queue) {
          return { name, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
        }
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        );
        return {
          name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
        };
      }),
    );
    return { data };
  }

  async listQueueJobs(input: {
    queue: string;
    status: 'waiting' | 'active' | 'delayed' | 'failed' | 'completed';
    page: number;
    limit: number;
  }): Promise<{ data: JobSummaryDto[]; meta: { page: number; limit: number } }> {
    const queue = queueOrThrow(input.queue);
    const start = input.page * input.limit;
    const end = start + input.limit - 1;
    const jobs = await queue.getJobs([input.status], start, end, false);
    return {
      data: jobs.map((job) => serializeJob(input.queue, job, input.status)),
      meta: { page: input.page, limit: input.limit },
    };
  }

  async getJob(queueName: string, jobId: string): Promise<{ data: JobSummaryDto }> {
    const queue = queueOrThrow(queueName);
    const job = await queue.getJob(jobId);
    if (!job) throw new JobNotFoundError(queueName, jobId);

    const state = await job.getState();
    return { data: serializeJob(queueName, job, state) };
  }

  /// Retrying re-runs a job's side effects and removing drops its work, so both are
  /// audited. The job lives in Redis, so no transaction can hold the row and the change
  /// together: `auditExternalAction` logs the request first and the outcome after. The
  /// row names the job but never carries `job.data` — an OTP job's payload is a secret.
  async mutateJob(
    queueName: string,
    jobId: string,
    action: 'retry' | 'remove',
    actor: AuditActor,
  ): Promise<void> {
    const queue = queueOrThrow(queueName);
    const job = await queue.getJob(jobId);
    if (!job) throw new JobNotFoundError(queueName, jobId);
    const state = await job.getState();

    await auditExternalAction(
      this.databaseService.client,
      {
        ...actor,
        action: action === 'retry' ? 'UPDATE' : 'DELETE',
        entityType: 'background_job',
        summary: `Job ${queueName}/${jobId} (${job.name}) ${action === 'retry' ? 'retried' : 'removed'}`,
        before: { queue: queueName, jobId, name: job.name, state, attemptsMade: job.attemptsMade },
      },
      () => (action === 'retry' ? job.retry() : job.remove()),
    );
  }

  async listSchedulers(): Promise<{ data: SchedulerDto[] }> {
    const scheduleMeta = new Map(
      JOB_SCHEDULES.map((schedule) => [`${schedule.queue}:${schedule.name}`, schedule]),
    );

    const data: SchedulerDto[] = [];

    for (const { name } of allManagedQueues()) {
      const queue = resolveQueue(name);
      if (!queue) continue;
      const schedulers = await queue.getJobSchedulers(0, 100);
      for (const scheduler of schedulers) {
        const key = `${name}:${scheduler.name ?? scheduler.id}`;
        const meta = scheduleMeta.get(key);
        data.push({
          id: scheduler.id ?? scheduler.name ?? key,
          queue: name,
          jobName: scheduler.name ?? meta?.name ?? 'unknown',
          pattern: scheduler.pattern ?? meta?.pattern ?? 'unknown',
          timezone: scheduler.tz ?? 'Etc/UTC',
          nextRunAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
        });
      }
    }

    for (const schedule of JOB_SCHEDULES) {
      const exists = data.some(
        (row) => row.queue === schedule.queue && row.jobName === schedule.name,
      );
      if (!exists) {
        data.push({
          id: schedule.name,
          queue: schedule.queue,
          jobName: schedule.name,
          pattern: schedule.pattern,
          timezone: 'Etc/UTC',
          nextRunAt: null,
        });
      }
    }

    return { data };
  }
}
