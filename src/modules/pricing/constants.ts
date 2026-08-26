/// The `PricingRule.cityCode` every category falls back to when no city has a
/// rate card of its own. Mirrors the value the catalog seed writes; kept here
/// rather than imported from `prisma/seed` so nothing in `src/` depends on the
/// seed scripts.
export const GLOBAL_PRICING_CITY_CODE = 'GLOBAL';
