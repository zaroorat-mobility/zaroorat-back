import { Worker, type Job } from 'bullmq';
import { logger } from '@shared/logger/index.js';
import type {
  NotificationDeliveryJob,
  NotificationDeliveryJobData,
  NotificationDeliveryJobResult,
} from '@modules/notifications/jobs/notification-delivery.job.js';
import { container } from '../../core/di.js';
import { QUEUE_NAMES, createQueueConnection } from '../queues/index.js';

function resolveJob(): NotificationDeliveryJob {
  return container.resolve<NotificationDeliveryJob>('notificationDeliveryJob');
}

export function startNotificationWorker(): Worker<
  NotificationDeliveryJobData,
  NotificationDeliveryJobResult
> {
  const worker = new Worker<NotificationDeliveryJobData, NotificationDeliveryJobResult>(
    QUEUE_NAMES.NOTIFICATIONS,
    (job: Job<NotificationDeliveryJobData, NotificationDeliveryJobResult>) =>
      resolveJob().run(job.data),
    {
      connection: createQueueConnection(),
      concurrency: 5,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info(
      { jobId: job.id, delivered: result.delivered, provider: result.provider },
      '[NotificationWorker] Job completed',
    );
  });

  worker.on('failed', (job, err) => {
    const attempts = job?.opts.attempts ?? 4;
    const made = job?.attemptsMade ?? 0;
    logger.error(
      { err, jobId: job?.id, attemptsMade: made, attempts },
      '[NotificationWorker] Job attempt failed',
    );

    if (job && made >= attempts) {
      void resolveJob()
        .markExhausted(job.data.deliveryId, job.data.notificationId, err.message)
        .catch((recordErr: unknown) => {
          logger.error(
            { err: recordErr, jobId: job.id },
            '[NotificationWorker] Failed to record job exhaustion',
          );
        });
    }
  });

  return worker;
}
