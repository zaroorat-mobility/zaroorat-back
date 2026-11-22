-- FR-038. Spatial indexes for the boundary columns every ride quote tests.
--
-- The repository already establishes this pattern twice — `saved_places.location`
-- in 20260801000000 and `driver_locations.location` in 20260815000000, the latter
-- with a comment explaining precisely why. The geographic migration added none,
-- so every ST_Contains / ST_Intersects in GeographicCoverageService,
-- PricingRuleRepository and SurgeRepository was a sequential scan with a polygon
-- test per row, on the first screen the customer app opens.
--
-- Indexed on the geometry cast, not the bare column. The predicates read
-- `ST_Contains(boundary::geometry, ...)`, and an index on `boundary` (geography)
-- cannot serve a geometry predicate — it would be built and never used, which is
-- worse than not building it, because it looks like the problem is solved.
--
-- CONCURRENTLY (constitution 3.4): these cannot be built concurrently inside
-- Prisma's migration transaction. On any environment where `cities` or
-- `service_zones` is non-trivial, run the CONCURRENTLY form manually BEFORE
-- `migrate deploy`; the IF NOT EXISTS below then makes this a no-op:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_cities_boundary_geom
--     ON "cities" USING GIST ((boundary::geometry));
CREATE INDEX IF NOT EXISTS "ix_cities_boundary_geom"
  ON "cities" USING GIST ((boundary::geometry));

CREATE INDEX IF NOT EXISTS "ix_service_zones_boundary_geom"
  ON "service_zones" USING GIST ((boundary::geometry));

-- `surge_zones` is being retired by BD-4, but the previous application version is
-- still querying it during the rollout and its predicate is a geography
-- ST_Intersects rather than a geometry cast. Indexed in its own shape, and it
-- goes away with the table in the deferred-drop release.
CREATE INDEX IF NOT EXISTS "ix_surge_zones_boundary"
  ON "surge_zones" USING GIST ("boundary");
