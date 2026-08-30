-- =====================================================================
-- Production pre-flight for feature 003-zone-pricing-integrity
--
-- Constitution 3.5: a constraint is verified against the target database
-- before deploy. Every query below is READ-ONLY. Run all of them against
-- PRODUCTION, in this order, BEFORE `prisma migrate deploy`.
--
-- A clean result on the test database proves nothing about production.
-- Ten migrations ship in this release; four of them add a constraint that
-- can fail against existing rows, and those four are what this file checks.
--
-- EXPECTED RESULT FOR EVERY QUERY: zero rows.
-- If a query returns rows, the required action is stated above it. Resolve
-- the data. Never weaken the constraint to make the migration pass.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. promotions.usage_limit_per_user  (migration 20260829100000)
--    Adds CHECK (usage_limit_per_user IS NULL OR >= 1).
--
-- IF ROWS FOUND: an operator configured a promotion nobody can redeem.
--   Decide per row whether it meant "unlimited" (set NULL) or a real cap
--   (set >= 1). Do this before deploy; the migration aborts otherwise.
-- ---------------------------------------------------------------------
SELECT id, code, usage_limit_per_user
FROM promotions
WHERE usage_limit_per_user IS NOT NULL
  AND usage_limit_per_user < 1;


-- ---------------------------------------------------------------------
-- 2. promotion_redemptions  (migration 20260829100000)
--    Backfills user_use_index by row_number() and adds a UNIQUE index on
--    (promotion_id, user_id, user_use_index).
--
-- This query is INFORMATIONAL, not a blocker: row_number() makes the
-- backfill unique by construction, so duplicates cannot fail the index.
-- What it tells you is how much over-redemption already happened — the
-- defect FR-017 closes. A large count is a refund/recovery conversation,
-- not a migration problem.
--
-- IF ROWS FOUND: record the totals for finance. No schema action needed.
-- ---------------------------------------------------------------------
SELECT r.promotion_id,
       p.code,
       r.user_id,
       COUNT(*)                    AS redemptions,
       p.usage_limit_per_user      AS allowed
FROM promotion_redemptions r
JOIN promotions p ON p.id = r.promotion_id
GROUP BY r.promotion_id, p.code, r.user_id, p.usage_limit_per_user
HAVING COUNT(*) > COALESCE(p.usage_limit_per_user, COUNT(*))
ORDER BY COUNT(*) DESC;


-- ---------------------------------------------------------------------
-- 3. Case-insensitive duplicate codes  (migration 20260829101000)
--    Adds UNIQUE indexes on upper(code) for promotions, coupons and
--    referral_codes, because lookup moves from ILIKE to exact match.
--
-- IF ROWS FOUND: two codes differing only in case exist. Exactly one may
--   survive per group. Deactivate or rename the others FIRST — picking the
--   survivor is a business decision, not a migration one. The migration
--   aborts until each group has one row.
-- ---------------------------------------------------------------------
SELECT 'promotions' AS table_name, upper(code) AS normalised, COUNT(*), array_agg(code) AS variants
FROM promotions GROUP BY upper(code) HAVING COUNT(*) > 1
UNION ALL
SELECT 'coupons', upper(code), COUNT(*), array_agg(code)
FROM coupons GROUP BY upper(code) HAVING COUNT(*) > 1
UNION ALL
SELECT 'referral_codes', upper(code), COUNT(*), array_agg(code)
FROM referral_codes GROUP BY upper(code) HAVING COUNT(*) > 1;


-- ---------------------------------------------------------------------
-- 4. pricing_rules overlapping live rules  (migration 20260829140000)
--    Adds two GiST EXCLUDE constraints: no two active rules on the same
--    key may cover overlapping effective windows.
--
--    THIS IS THE MOST LIKELY MIGRATION TO FAIL. Rows here are FR-034's
--    race having already happened — two admins saved the same key at once
--    and both rules went live, so the same journey could be quoted at two
--    different prices.
--
-- IF ROWS FOUND: a human must choose which rule wins per pair, then either
--   set is_active = false on the loser, or close the incumbent's
--   effective_to so the windows no longer overlap. Do NOT widen or drop
--   the constraint. Record which rule was chosen and why — this changes
--   prices.
-- ---------------------------------------------------------------------
SELECT a.id            AS rule_a,
       b.id            AS rule_b,
       a.vehicle_type_id,
       a.city_code,
       a.service_type,
       a.service_zone_id,
       a.base_fare     AS base_fare_a,
       b.base_fare     AS base_fare_b,
       a.effective_from AS from_a, a.effective_to AS to_a,
       b.effective_from AS from_b, b.effective_to AS to_b
FROM pricing_rules a
JOIN pricing_rules b
  ON a.id < b.id
 AND a.vehicle_type_id = b.vehicle_type_id
 AND a.city_code       = b.city_code
 AND a.service_type    IS NOT DISTINCT FROM b.service_type
 AND a.service_zone_id IS NOT DISTINCT FROM b.service_zone_id
 AND tsrange(a.effective_from, a.effective_to)
  && tsrange(b.effective_from, b.effective_to)
WHERE a.is_active AND b.is_active;


-- ---------------------------------------------------------------------
-- 5. btree_gist availability  (migration 20260829140000)
--    The EXCLUDE constraints need it. The migration runs
--    CREATE EXTENSION IF NOT EXISTS btree_gist, which requires the
--    migration role to be superuser or to have CREATE on the database.
--
-- IF THIS RETURNS 'f': install the extension out of band, as a role that
--   can, before deploy. Otherwise migration 9 fails on a permission error
--   rather than on your data.
-- ---------------------------------------------------------------------
SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist')
         AS btree_gist_installed,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis')
         AS postgis_installed;


-- ---------------------------------------------------------------------
-- 6. Table sizes for the CONCURRENTLY decision  (migration 20260829120000)
--    Three GiST indexes on cities, service_zones and surge_zones.
--    Constitution 3.4: they cannot be built CONCURRENTLY inside Prisma's
--    migration transaction, so they take an ACCESS EXCLUSIVE lock.
--
-- IF ANY TABLE IS NON-TRIVIAL (say > 50k rows, or a lock of more than a
--   second or two is unacceptable): build all three manually with
--   CREATE INDEX CONCURRENTLY BEFORE running migrate deploy. The migration
--   carries IF NOT EXISTS, so it then degrades to a no-op.
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_cities_boundary_geom
--     ON cities USING GIST ((boundary::geometry));
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_service_zones_boundary_geom
--     ON service_zones USING GIST ((boundary::geometry));
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_surge_zones_boundary
--     ON surge_zones USING GIST (boundary);
--
--   Note the cast: the predicates read ST_Contains(boundary::geometry, ...),
--   so an index on the bare geography column would be built and never used.
-- ---------------------------------------------------------------------
SELECT relname,
       n_live_tup           AS approx_rows,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname IN ('cities', 'service_zones', 'surge_zones',
                  'pricing_rules', 'promotion_redemptions', 'ride_requests')
ORDER BY n_live_tup DESC;


-- ---------------------------------------------------------------------
-- 7. Surge windows that the BD-4 backfill will NOT match
--    (migration 20260829130000)
--
--    The backfill re-points a surge window at a ServiceZone only when the
--    two polygons are ST_Equals in the same city — the "someone drew the
--    same shape twice" case. It deliberately does not match by overlap or
--    centroid: re-pointing a window that merely sits inside a service zone
--    would change which rides surge, and a migration does not get to make
--    a pricing decision.
--
-- IF ROWS FOUND: nothing breaks. Those windows keep resolving through the
--   legacy surge_zones path for one release. BUT they must be re-pointed
--   by an operator before the deferred drop
--   (deferred/drop_legacy_surge_geography.sql) can run — that drop is
--   gated on this query returning zero.
-- ---------------------------------------------------------------------
SELECT sw.id           AS surge_window_id,
       sw.zone_id      AS legacy_surge_zone_id,
       surz.name       AS legacy_zone_name,
       surz.city_code,
       sw.multiplier,
       sw.is_active
FROM surge_windows sw
JOIN surge_zones surz ON surz.id = sw.zone_id
WHERE sw.service_zone_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM cities c
    JOIN service_zones sz
      ON sz.city_id = c.id AND sz.is_active
    WHERE c.code = surz.city_code
      AND ST_Equals(sz.boundary::geometry, surz.boundary::geometry)
  );


-- ---------------------------------------------------------------------
-- 8. Rollout-window note, NOT a query.
--
--    Migration 20260829100000 adds a UNIQUE index on
--    (promotion_id, user_id, user_use_index) with DEFAULT 1.
--
--    During migrate-then-deploy, the PREVIOUS application version inserts
--    redemptions without user_use_index, so every one of its inserts takes
--    the default of 1. A second redemption by the same user on the same
--    promotion will therefore raise a unique violation in the old code
--    instead of silently over-redeeming.
--
--    That is the defect being fixed, surfacing one release early. It is
--    acceptable — a refused duplicate redemption is the correct outcome —
--    but it is a visible behaviour change during the rollout window, so
--    keep the window short and watch promotion error rates.
-- ---------------------------------------------------------------------
