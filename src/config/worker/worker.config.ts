export const workerConfig = Object.freeze({
  healthHost: process.env.WORKER_HEALTH_HOST ?? '0.0.0.0',
  healthPort: Number(process.env.WORKER_HEALTH_PORT ?? 3001),
  otpConcurrency: Number(process.env.OTP_WORKER_CONCURRENCY ?? 20),
  shutdownGraceMs: Number(process.env.WORKER_SHUTDOWN_GRACE_MS ?? 120000),
});
export type WorkerConfig = typeof workerConfig;
