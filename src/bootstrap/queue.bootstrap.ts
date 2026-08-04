import { logger } from '@shared/logger/index.js';
import { registerJobSchedules } from '../jobs/scheduler/index.js';

/**
 * Installs every recurring job schedule (handbook volume 08 §28).
 *
 * Called from the **worker** entry point, not the API's. Registering schedules
 * from a process that cannot process them would enqueue a job every fifteen
 * minutes into a queue with no consumer: unbounded Redis growth whose only
 * symptom is a memory graph. The process that runs the jobs is the process that
 * schedules them, so "no workers deployed" means "nothing accumulating" rather
 * than a slow leak nobody is watching. Upserting by job name keeps it correct
 * when several worker replicas do it at once.
 */
export async function bootstrapQueue(): Promise<void> {
  await registerJobSchedules();
  logger.info('Job schedules registered');
}
