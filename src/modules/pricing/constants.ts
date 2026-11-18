/// The `PricingRule.cityCode` every category falls back to when no city has a
/// rate card of its own. Mirrors the value the catalog seed writes; kept here
/// rather than imported from `prisma/seed` so nothing in `src/` depends on the
/// seed scripts.
export const GLOBAL_PRICING_CITY_CODE = 'GLOBAL';

/// Shared feature flag key for surge pricing (Phase 2.5 layering boundary:
/// domain pricing never imports from `modules/admin`).
export const SURGE_FEATURE_FLAG_KEY = 'surge' as const;

export interface FeatureFlagReader {
  isOn(key: string): Promise<boolean>;
}
