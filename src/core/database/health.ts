import { logger } from '@shared/logger/index.js';
import prisma from './client';

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    // A simple query to verify the connection is alive
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Database health check failed');
    return false;
  }
}
