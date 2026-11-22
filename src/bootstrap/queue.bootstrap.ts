import { logger } from '@shared/logger/index.js';
import { registerJobSchedules } from '../jobs/scheduler/index.js';
export async function bootstrapQueue(): Promise<void> {
  await registerJobSchedules();
  logger.info('Job schedules registered');
}
