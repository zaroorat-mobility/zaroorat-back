import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';

// ---------------------------------------------------------------------------
// Raw spatial / location metrics (formerly GeoMetrics in geo/metrics/)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Business / service-zone metrics (formerly GeographicMetrics in geographic/metrics/)
// ---------------------------------------------------------------------------

export type GeographicMetricFields = Record<string, string | number | boolean>;

export class GeographicMetrics {
  /// BD-10. No active city carries a boundary, so coverage is not configured and
  /// the pickup gate stood down rather than refusing the ride. This must never be
  /// a silent state: from the customer's side it is indistinguishable from a
  /// platform that has decided to operate everywhere, and from the operator's
  /// side it looks like the geographic module is working.
  coverageUnconfigured(fields?: GeographicMetricFields): void {
    this.emit('coverage_unconfigured_total', fields);
  }

  /// Coverage *is* configured and the pickup fell outside all of it — a refusal
  /// the operator meant, as opposed to the one above.
  pickupOutsideCoverage(fields?: GeographicMetricFields): void {
    this.emit('pickup_outside_coverage_total', fields);
  }

  private emit(metric: string, fields?: GeographicMetricFields, by = 1): void {
    const name = `geographic.${metric}`;
    incrementCounter(name, fields, by);
    logger.info({ metric: name, ...fields }, `[metric] ${name}`);
  }
}
