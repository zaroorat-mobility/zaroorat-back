-- Claim ownership for the outbox relay.
--
-- Without it, every retire path (`markPublished`, `releaseForRetry`, `markDead`)
-- matched on row id alone, so a relay whose claim had been reaped could still
-- overwrite the result of the relay that held the row afterwards — retiring an
-- event whose only delivery attempt had failed and been scheduled for retry.
--
-- Nullable with no backfill: rows claimed before this migration carry a NULL
-- token, and the reaper returns them to PENDING on its next pass.

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN "claim_token" UUID;
