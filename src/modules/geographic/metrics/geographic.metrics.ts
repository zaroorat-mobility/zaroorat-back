import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';

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
