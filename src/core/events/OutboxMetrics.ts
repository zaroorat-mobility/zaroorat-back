import { logger } from '@shared/logger/index.js';
import { incrementCounter, setGauge } from '@core/metrics';
export type OutboxMetricFields = Record<string, string | number | boolean>;
export class OutboxMetrics {
  batchProcessed(fields?: OutboxMetricFields): void {
    this.emit('batch.processed', fields);
  }
  dispatchFailed(fields?: OutboxMetricFields): void {
    this.emit('dispatch.failed', fields);
  }
  deadLettered(fields?: OutboxMetricFields): void {
    this.emit('dead_lettered', fields);
  }
  claimsReclaimed(fields?: OutboxMetricFields): void {
    this.emit('claims.reclaimed', fields);
  }
  claimsLost(fields?: OutboxMetricFields): void {
    this.emit('claims.lost', fields);
  }
  observabilityDropped(fields?: OutboxMetricFields): void {
    this.emit('observability.dropped', fields);
  }
  pruned(fields?: OutboxMetricFields): void {
    this.emit('pruned', fields);
  }
  backlog(fields?: OutboxMetricFields): void {
    if (typeof fields?.pending === 'number') {
      setGauge('outbox_pending', fields.pending);
    }
    if (typeof fields?.oldestPendingAgeMs === 'number') {
      setGauge('outbox_oldest_pending_age_ms', fields.oldestPendingAgeMs);
    }
    if (typeof fields?.failed === 'number') {
      setGauge('outbox_failed', fields.failed);
    }
    this.emit('backlog', fields);
  }
  private emit(event: string, fields?: OutboxMetricFields): void {
    incrementCounter(`outbox_${event.replace(/\./g, '_')}`, fields);
    logger.info({ metric: `outbox.${event}`, ...fields }, `[OutboxMetrics] ${event}`);
  }
}
