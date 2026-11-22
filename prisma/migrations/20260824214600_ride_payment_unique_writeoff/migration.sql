-- One write-off per ride (BD-1c).
--
-- BD-1c requires the write-off be idempotent and duplicate write-offs
-- impossible -- not merely unlikely. A repeated sweep run violates this index
-- rather than posting a second BAD_DEBT_EXPENSE group, which is what makes
-- the guarantee structural instead of best-effort.
--
-- Structurally identical to ride_payments_ride_id_succeeded_key.
--
-- LARGE-TABLE ROLLOUT: create manually with CONCURRENTLY before
-- `prisma migrate deploy`; the IF NOT EXISTS makes this a no-op afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS "ride_payments_ride_id_written_off_key"
  ON "ride_payments" ("ride_id")
  WHERE "status" = 'WRITTEN_OFF';
