import { Worker, type Job } from 'bullmq';
import { workerConfig } from '@config/worker/worker.config.js';
import { logger } from '@shared/logger/index.js';
import type { OtpDeliveryJob, OtpDeliveryResult } from '@modules/auth/jobs/otp-delivery.job.js';
import { container } from '../../core/di.js';
import { QUEUE_NAMES, createQueueConnection } from '../queues/index.js';
import type { OtpDeliveryJobData } from '../producers/index.js';
function resolveJob(): OtpDeliveryJob {
  return container.resolve<OtpDeliveryJob>('otpDeliveryJob');
}
export function startOtpWorker(): Worker<OtpDeliveryJobData, OtpDeliveryResult> {
  const worker = new Worker<OtpDeliveryJobData, OtpDeliveryResult>(
    QUEUE_NAMES.AUTH_OTP,
    (job: Job<OtpDeliveryJobData, OtpDeliveryResult>) => resolveJob().run(job.data),
    {
      connection: createQueueConnection(),
      concurrency: workerConfig.otpConcurrency,
    },
  );
  worker.on('completed', (job, result) => {
    logger.info(
      { jobId: job.id, delivered: result.delivered, provider: result.provider },
      '[OTP] delivery job completed',
    );
  });
  worker.on('failed', (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    logger.error(
      { err, jobId: job?.id, attemptsMade: made, attempts },
      '[OTP] delivery job failed',
    );
    if (job && made >= attempts) {
      void resolveJob()
        .markExhausted(job.data.challengeId, err.message)
        .catch((recordErr: unknown) => {
          logger.error({ err: recordErr, jobId: job.id }, '[OTP] failed to record exhaustion');
        });
    }
  });
  return worker;
}
