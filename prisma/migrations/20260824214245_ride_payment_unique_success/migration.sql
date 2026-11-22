-- Exactly-once collection: at most one SUCCEEDED payment per ride.
--
-- This index -- not the Redis lock in RideCollectionService -- is the
-- correctness boundary. A lock lost to a crash, a duplicate outbox delivery,
-- or two concurrent retries all fall through to this constraint, which is why
-- it is a database guarantee rather than application logic.
--
-- Prisma cannot express a partial unique index, so it is raw SQL here, the
-- same approach as 20260810100000_ride_request_unique and
-- 20260821130000_ride_active_uniqueness.
--
-- LARGE-TABLE ROLLOUT: CREATE INDEX CONCURRENTLY cannot run inside Prisma's
-- migration transaction. On a production ride_payments table of meaningful
-- size, run this manually BEFORE `prisma migrate deploy`:
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ride_payments_ride_id_succeeded_key"
--     ON "ride_payments" ("ride_id") WHERE "status" = 'SUCCEEDED';
--
-- The IF NOT EXISTS below then makes this migration a no-op.
--
-- BACKWARD COMPATIBILITY: no code writes ride_payments today, so the index
-- cannot conflict with the currently deployed application version.
CREATE UNIQUE INDEX IF NOT EXISTS "ride_payments_ride_id_succeeded_key"
  ON "ride_payments" ("ride_id")
  WHERE "status" = 'SUCCEEDED';
