-- FR-047. Schema no code path reads.
--
-- The application stopped reading all of this in the Phase 6 release. Run one
-- release later, when no previous app version is still selecting the columns.
--
-- Pre-flight (expect zero rows, and confirm against PRODUCTION, not test):
--   SELECT count(*) FROM toll_zones;
--   SELECT count(*) FROM tax_configs;
--   SELECT count(*) FROM pricing_rules WHERE night_multiplier <> 1.0;
--   SELECT count(*) FROM pricing_rules WHERE included_km <> 0;
--
-- A non-zero count on either of the last two means an operator configured
-- something the platform never charged. That is a product conversation, not a
-- reason to keep the column: decide whether to build the feature, then drop.

DROP TABLE IF EXISTS "toll_zones";
DROP TABLE IF EXISTS "tax_configs";

ALTER TABLE "pricing_rules" DROP COLUMN IF EXISTS "included_km";
ALTER TABLE "pricing_rules" DROP COLUMN IF EXISTS "night_multiplier";
