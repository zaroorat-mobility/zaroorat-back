-- `otp_verifications` is the highest-write table in the schema: a row per OTP
-- send and a row per verify attempt. Nothing ever trimmed it, because both
-- `purgeExpired` methods had zero callers; `AuthRetentionJob` now runs nightly
-- (R-AUTH-26) and its only query is
--
--   DELETE FROM otp_verifications
--   WHERE id IN (SELECT id FROM otp_verifications
--                WHERE expires_at < $1 ORDER BY expires_at ASC LIMIT $2)
--
-- The existing indexes cover `phone_number` and `created_at`, neither of which
-- helps that predicate — so without this the purge is a sequential scan plus a
-- top-N sort of the whole table on every batch.
--
-- Plain build, not CONCURRENTLY, for the reason `20260801000000` already records:
-- Prisma runs each migration in a transaction and offers no supported way to opt
-- out, and CONCURRENTLY cannot run inside one. If this table is already large
-- when the migration lands, build the index out-of-band instead and let the
-- IF NOT EXISTS make this a no-op.
CREATE INDEX IF NOT EXISTS "otp_verifications_expires_at_idx"
  ON "otp_verifications" ("expires_at");
