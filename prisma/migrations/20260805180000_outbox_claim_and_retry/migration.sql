-- Outbox relay: atomic claim, bounded retry, and an index for the poll query.
--
-- `ALTER TYPE ... ADD VALUE` is safe inside this transaction on PG12+ so long as
-- the new label is not *used* here — it is not; only later application writes
-- reference PROCESSING.

-- AlterEnum
ALTER TYPE "OutboxStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "outbox_events"
    ADD COLUMN "event_id" UUID,
    ADD COLUMN "last_error" TEXT,
    ADD COLUMN "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "claimed_at" TIMESTAMP(3);

-- Backfill: rows written before this column carry the envelope id inside the
-- payload. The regex guard keeps a malformed payload from aborting the whole
-- migration on a cast error.
UPDATE "outbox_events"
SET "event_id" = ("payload" ->> 'eventId')::uuid
WHERE "event_id" IS NULL
  AND "payload" ->> 'eventId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- Anything still null had no usable envelope id. The row id is unique by
-- construction, so the NOT NULL below stays honest without inventing a value
-- that could collide.
UPDATE "outbox_events"
SET "event_id" = "id"
WHERE "event_id" IS NULL;

ALTER TABLE "outbox_events" ALTER COLUMN "event_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_event_id_key" ON "outbox_events" ("event_id");

-- CreateIndex
-- The relay's claim query, verbatim: status + due time, ordered by (created_at, id).
CREATE INDEX "outbox_events_status_next_attempt_at_created_at_id_idx" ON "outbox_events" ("status", "next_attempt_at", "created_at", "id");
