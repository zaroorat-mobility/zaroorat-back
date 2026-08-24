-- Sweep support for the bounded collection retry (BD-4) and the ageing
-- receivable write-off (BD-1c). Both scan ride_payments by status and age.
--
-- LARGE-TABLE ROLLOUT: create manually with CONCURRENTLY before
-- `prisma migrate deploy`; the IF NOT EXISTS makes this a no-op afterwards.
CREATE INDEX IF NOT EXISTS "ride_payments_status_created_at_idx"
  ON "ride_payments" ("status", "created_at");
