import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';
export type GeoMetricFields = Record<string, string | number | boolean>;
export class GeoMetrics {
  positionRecorded(fields?: GeoMetricFields): void {
    this.emit('position_recorded_total', fields);
  }
  positionRejectedStale(fields?: GeoMetricFields): void {
    this.emit('position_rejected_stale_total', fields);
  }
  nearbyRequested(fields?: GeoMetricFields): void {
    this.emit('nearby_requests_total', fields);
  }
  nearbyCandidates(count: number, fields?: GeoMetricFields): void {
    this.emit('nearby_candidates_total', fields, count);
  }
  noLiveCandidates(fields?: GeoMetricFields): void {
    this.emit('no_live_candidates_total', fields);
  }
  postgisFallback(fields?: GeoMetricFields): void {
    this.emit('postgis_fallback_total', fields);
  }
  redisError(fields?: GeoMetricFields): void {
    this.emit('redis_errors_total', fields);
  }
  private emit(metric: string, fields?: GeoMetricFields, by = 1): void {
    const name = `geo.${metric}`;
    incrementCounter(name, fields, by);
    logger.info({ metric: name, ...fields }, `[metric] ${name}`);
  }
}
