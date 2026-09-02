-- BD-4 / FR-014. Retires the second surge geography.
--
-- Phase 5 made `ServiceZone` the polygon of record and backfilled only the surge
-- zones it could match by `ST_Equals`. Anything unmatched still resolves through
-- `zone_id`, so this cannot run until every window carries a service zone.
--
-- Pre-flight — BOTH must return 0 against PRODUCTION:
--   SELECT count(*) FROM surge_windows WHERE service_zone_id IS NULL;
--   SELECT count(*) FROM surge_zones WHERE is_active;
--
-- If the first is non-zero, an operator must re-point those windows by hand. A
-- migration must not guess which service zone a surge polygon meant.

ALTER TABLE "surge_windows" DROP CONSTRAINT IF EXISTS "surge_windows_zone_id_fkey";
DROP INDEX IF EXISTS "surge_windows_zone_id_starts_at_idx";
ALTER TABLE "surge_windows" DROP COLUMN IF EXISTS "zone_id";
ALTER TABLE "surge_windows" DROP COLUMN IF EXISTS "demand_threshold_pct";
ALTER TABLE "surge_windows" DROP COLUMN IF EXISTS "supply_threshold_pct";
ALTER TABLE "surge_windows" ALTER COLUMN "service_zone_id" SET NOT NULL;

DROP TABLE IF EXISTS "surge_zones";
