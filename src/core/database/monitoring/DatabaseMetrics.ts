import { logger } from '@shared/logger/index.js';

export class DatabaseMetrics {
  /// The SQL text is logged at `debug`, not `warn`.
  ///
  /// A warning carried the whole statement, so a single slow query filled the
  /// terminal with several lines of escaped SQL. The outbox relay polls once a
  /// second with a write (`UPDATE ... FOR UPDATE SKIP LOCKED`), which on a
  /// containerised Postgres routinely costs more than the threshold — so an idle
  /// development server scrolled its own query text past everything the
  /// developer was actually trying to read.
  ///
  /// The warning still fires, still says how slow, and the statement is one
  /// `LOG_LEVEL=debug` away.
  public recordSlowQuery(query: string, durationMs: number): void {
    logger.warn(
      { durationMs: Math.round(durationMs) },
      `[db] slow query ${Math.round(durationMs)}ms (LOG_LEVEL=debug to see the statement)`,
    );
    logger.debug({ query, durationMs }, '[db] slow query statement');
  }

  public recordError(errorName: string, message: string): void {
    logger.error({ errorName, message }, `[DB Error] ${errorName}: ${message}`);
  }

  public recordConnectionEstablished(): void {
    logger.debug('[DB Metric] Connection established');
  }
}
