import type { Job } from 'bullmq';
import { JOB_SCHEDULES } from '@/jobs/scheduler/index.js';
import { allManagedQueues, resolveQueue } from '@/jobs/queues/index.js';
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
  failedReason: string | null;
  data: unknown;
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
    failedReason: job.failedReason ?? null,
    data: job.data,
  };
}

export class AdminJobsService {
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

  async mutateJob(queueName: string, jobId: string, action: 'retry' | 'remove'): Promise<void> {
    const queue = queueOrThrow(queueName);
    const job = await queue.getJob(jobId);
    if (!job) throw new JobNotFoundError(queueName, jobId);

    if (action === 'retry') {
      await job.retry();
      return;
    }
    await job.remove();
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
