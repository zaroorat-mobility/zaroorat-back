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

const SHUTDOWN_GRACE_MS = 120_000;

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

function registerWorkerShutdown(workers: Worker[]): void {
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
