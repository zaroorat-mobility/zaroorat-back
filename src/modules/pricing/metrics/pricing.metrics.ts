import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';

export type PricingMetricFields = Record<string, string | number | boolean>;

/// Constitution 17.1: every money-affecting operation emits a domain metric.
/// Pricing decides what every customer pays and what every driver earns, and was
/// the one such module with no metrics class at all.
export class PricingMetrics {
  /// FR-016. Surge resolution failed and the safe default was returned.
  ///
  /// The fallback is correct — a booking must not fail because a surge lookup
  /// did — but it makes a broken polygon, a dropped connection and a genuinely
  /// quiet zone indistinguishable. Without this counter, surge silently stops
  /// applying and nothing says so.
  surgeResolutionFailed(fields?: PricingMetricFields): void {
    this.emit('surge_resolution_failed_total', fields);
  }

  /// A ride was priced on `pricingConfig.defaultRateCard` because no rule
  /// matched. Expected for a category with no rule of its own; a spike means a
  /// city's rules have been orphaned — which is exactly what renaming a city
  /// code used to do silently (FR-029).
  rateCardFallback(fields?: PricingMetricFields): void {
    this.emit('rate_card_fallback_total', fields);
  }

  /// FR-002. A completed ride carried no `pricingRuleId`, so the bill was priced
  /// by re-resolving rather than by re-reading the booked rule. Expected only for
  /// requests written before the column existed; should decay to zero.
  finalFareRuleMissing(fields?: PricingMetricFields): void {
    this.emit('final_fare_rule_missing_total', fields);
  }

  private emit(metric: string, fields?: PricingMetricFields, by = 1): void {
    const name = `pricing.${metric}`;
    incrementCounter(name, fields, by);
    logger.info({ metric: name, ...fields }, `[metric] ${name}`);
  }
}
