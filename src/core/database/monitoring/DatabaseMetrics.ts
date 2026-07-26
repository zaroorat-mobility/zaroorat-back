import { logger } from '@shared/logger/index.js';

export class DatabaseMetrics {
  public recordSlowQuery(query: string, durationMs: number): void {
    logger.warn({ query, durationMs }, `[DB Slow Query] ${durationMs}ms`);
  }

  public recordError(errorName: string, message: string): void {
    logger.error({ errorName, message }, `[DB Error] ${errorName}: ${message}`);
  }

  public recordConnectionEstablished(): void {
    logger.debug('[DB Metric] Connection established');
  }
}
