-- Rider outstanding-receivable aggregate (BD-2).
--
-- The debt total is read on EVERY ride request, and `rides` is the largest
-- table in the system. Without this index that guard is a sequential scan on
-- the hottest write path the platform has.
--
-- LARGE-TABLE ROLLOUT: create manually with CONCURRENTLY before
-- `prisma migrate deploy`; the IF NOT EXISTS makes this a no-op afterwards.
CREATE INDEX IF NOT EXISTS "rides_customer_id_payment_status_idx"
  ON "rides" ("customer_id", "payment_status");
