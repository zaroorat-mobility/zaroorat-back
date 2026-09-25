-- Retention scan support for `notifications` and `notification_deliveries`.
--
-- Nothing prunes either table today. The outbox prunes published rows at 30 days
-- (`OutboxRelay.prunePublished`); notifications grow without bound. The retention
-- sweep that fixes that filters on age alone, across every user and every channel:
--
--   DELETE FROM notification_deliveries
--   WHERE id IN (SELECT id FROM notification_deliveries
--                WHERE created_at < $1 ORDER BY created_at ASC LIMIT $2)
--
-- Neither table can serve that predicate with what it already has:
--
--   notifications           has (user_id, created_at) — leads on user_id, so a
--                           created_at-only filter cannot use it.
--   notification_deliveries has (channel, created_at) — leads on channel. The
--                           sweep prunes every channel together and so constrains
--                           no channel, leaving the index unusable for it.
--
-- Without these, every sweep batch is a sequential scan plus a top-N sort of the
-- whole table — which is exactly the shape `20260809120000_otp_retention_index`
-- was written to avoid on `otp_verifications`.
--
-- ## Build strategy
--
-- Plain build, not CONCURRENTLY, for the reason `20260801000000` records: Prisma
-- runs each migration in a transaction and offers no supported way to opt out, and
-- CONCURRENTLY cannot run inside one.
--
-- These tables are small today — no user-facing notification API exists, so
-- nothing reads them and only the ride pipeline writes them. If they are already
-- large when this lands, build both out-of-band first and let IF NOT EXISTS turn
-- this migration into a no-op:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_created_at_idx"
--     ON "notifications" ("created_at");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "notification_deliveries_created_at_idx"
--     ON "notification_deliveries" ("created_at");
--
-- Additive and non-unique: no pre-flight data check is needed and nothing here can
-- fail on existing rows. That is what separates this from the `fcm_token` unique
-- index, which is deliberately NOT in this migration — it can fail on duplicates,
-- and it waits on the production duplicate-token audit.
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx"
  ON "notifications" ("created_at");

CREATE INDEX IF NOT EXISTS "notification_deliveries_created_at_idx"
  ON "notification_deliveries" ("created_at");
