-- FR-015 / BD-4 option A. Surge stops keeping its own geography.
--
-- `SurgeZone` is a standalone table with its own geography(Polygon,4326) and a
-- free-text `city_code` carrying no foreign key to `cities` and no relation to
-- `service_zones`. `findActiveZonesForLocation` ran its own ST_Intersects against
-- it and never touched the zones the geographic module manages. Operators drew
-- every polygon twice and the two drifted; a surge zone could sit entirely
-- outside every city boundary and still multiply fares.
--
-- Expand only. `service_zone_id` is nullable and the old column stays, because
-- migrate-then-deploy leaves the previous application version running and it
-- still reads `surge_zones` (constitution 16.2). The repository resolves BOTH
-- for one release: windows that were backfilled resolve through service zones,
-- windows that could not be resolve through the legacy table exactly as before.
-- The table drop is a named follow-up, recorded in plan.md.
ALTER TABLE "surge_windows" ADD COLUMN "service_zone_id" UUID;

-- `zone_id` becomes optional so a window can exist against a service zone alone.
-- It is NOT NULL today with a foreign key to `surge_zones`, so without this a
-- service-zone-only window could not be written at all. Dropping a NOT NULL is
-- backward compatible: the previous application version still supplies the
-- column, and its rows are unaffected.
ALTER TABLE "surge_windows" ALTER COLUMN "zone_id" DROP NOT NULL;

ALTER TABLE "surge_windows"
  ADD CONSTRAINT "surge_windows_service_zone_id_fkey"
  FOREIGN KEY ("service_zone_id") REFERENCES "service_zones"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "surge_windows_service_zone_id_starts_at_idx"
  ON "surge_windows" ("service_zone_id", "starts_at");

-- Backfill only where a service zone is provably the same area: same city, and a
-- geometrically equal boundary. That is the "drew the same polygon twice" case
-- the review found, and it is the only one that can be matched without guessing.
--
-- Deliberately NOT matched by overlap or by centroid containment. A surge zone
-- that merely sits inside a service zone is not the same area, and silently
-- re-pointing it would change which rides surge — a pricing change made by a
-- migration, which is not a decision a migration gets to make. Anything left
-- NULL keeps working through the legacy path until an operator re-points it.
UPDATE "surge_windows" sw
SET "service_zone_id" = sz."id"
FROM "surge_zones" surz
JOIN "cities" c ON c."code" = surz."city_code"
JOIN "service_zones" sz
  ON sz."city_id" = c."id"
 AND sz."is_active" = true
 AND ST_Equals(sz."boundary"::geometry, surz."boundary"::geometry)
WHERE sw."zone_id" = surz."id"
  AND sw."service_zone_id" IS NULL;
