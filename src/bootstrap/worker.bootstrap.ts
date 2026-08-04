import type { Worker } from 'bullmq';

import { config } from '@config';
import { redis } from '@core/cache/client.js';
import { PrismaClientProvider } from '@core/database/client/PrismaClientProvider.js';
import { logger } from '@shared/logger/index.js';
import { container } from '../core/di.js';
import { closeQueues } from '../jobs/queues/index.js';
import { startMaintenanceWorkers } from '../jobs/workers/index.js';
import { bootstrapDatabase } from './database.bootstrap.js';
import { bootstrapQueue } from './queue.bootstrap.js';
import { bootstrapRedis } from './redis.bootstrap.js';

/**
 * How long in-flight jobs get to finish on SIGTERM (volume 08 §35).
 *
 * Sized off the longest job: the sweeper holds a 10-minute lock but a batch of
 * 500 deletes is far quicker, and retention isolates failure per file. Two
 * minutes lets a normal batch drain; anything still running past that is stuck,
 * and BullMQ's stalled-job recovery will requeue it — which is safe, because
 * both jobs are idempotent.
 */
const SHUTDOWN_GRACE_MS = 120_000;

/**
 * Starts the background-job worker process.
 *
 * Shares the API's composition root (`core/di.js`) rather than re-wiring
 * services, which is the whole point of volume 08 §31 — one place where a
 * dependency change lands, instead of two that drift. What it does *not* share
 * is the Fastify surface or the outbox relay: the relay is a single-instance
 * poller (auth doc 06 §2), and a second one here would dispatch every event
 * twice. Jobs still publish events, because publishing is a write to the outbox
 * inside their transaction — the API's relay picks them up.
 * @returns The running worker.
 */
export async function startWorker(): Promise<Worker[]> {
  try {
    await bootstrapDatabase();
    await bootstrapRedis();
    await bootstrapQueue();

    const workers = startMaintenanceWorkers();
    registerWorkerShutdown(workers);

    logger.info(
      { queues: workers.map((worker) => worker.name) },
      `Worker started — environment: ${config.app.environment}`,
    );
    return workers;
  } catch (err) {
    logger.error({ err }, 'Failed to start worker');
    process.exit(1);
  }
}

/**
 * Drain in-flight jobs, then release every connection (volume 08 §35).
 *
 * `worker.close()` stops pulling new jobs and waits for the current one — the
 * ordering that keeps a routine rollout from manufacturing stalled jobs that
 * then need recovery. Every worker drains in parallel; they share nothing but
 * the grace period.
 * @param workers The workers to stop.
 */
function registerWorkerShutdown(workers: Worker[]): void {
  // Guard against double-SIGTERM races, the same way the API's shutdown does.
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}. Draining jobs...`);

    const forceExit = setTimeout(() => {
      logger.error('Grace period elapsed with jobs still running. Exiting.');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    try {
      await Promise.all(workers.map((worker) => worker.close()));
      logger.info('Workers closed.');

      await closeQueues();
      await container.resolve<PrismaClientProvider>('provider').disconnect();
      await redis.quit();

      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
