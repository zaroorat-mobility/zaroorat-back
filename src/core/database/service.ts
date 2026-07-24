import { logger } from '@shared/logger/index.js';
import prisma from './client';

export class DatabaseService {
  /**
   * Initializes the database connection.
   */
  static async connect() {
    await prisma.$connect();
    logger.info('Database connected successfully');
  }

  /**
   * Safely closes the database connection.
   */
  static async disconnect() {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  }
}
