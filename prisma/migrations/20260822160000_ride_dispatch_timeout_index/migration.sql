-- DispatchTimeoutJob sweeps `response = 'PENDING' AND expires_at <= now()` on
-- every tick. The existing ix on `response` alone is near-useless for it:
-- PENDING is the hot value, so the planner reads essentially every live offer
-- and filters on expires_at afterwards. The composite turns that into a range
-- scan over exactly the rows the job is going to act on.
--
-- CONCURRENTLY is deliberately NOT used: Prisma Migrate wraps each migration in
-- a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one. On a large
-- ride_dispatches table, build this by hand outside the migration instead:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ride_dispatches_response_expires_at_idx"
--     ON "ride_dispatches" ("response", "expires_at");
-- and then let this statement no-op.
CREATE INDEX IF NOT EXISTS "ride_dispatches_response_expires_at_idx"
  ON "ride_dispatches" ("response", "expires_at");
