-- The driver map's demand layer counts ride requests made in the last few
-- minutes inside the viewport (drivers/services/map-zones). Nothing indexed
-- `created_at`, so every map refresh would scan the whole table.
--
-- Plain build, not CONCURRENTLY, for the reason `20260801000000` records: Prisma
-- runs each migration in a transaction and CONCURRENTLY cannot run inside one.
-- If `ride_requests` is already large when this lands, build the index
-- out-of-band and let IF NOT EXISTS make this a no-op.
CREATE INDEX IF NOT EXISTS "ride_requests_created_at_idx"
  ON "ride_requests" ("created_at");
