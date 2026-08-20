-- The deletion-request ledger (user doc 02 §2.8, doc 03 §6, R-USER-18/19).
--
-- Additive only: one enum, one table, no existing object touched. Safe under a
-- rolling deploy — old code never queries it, and the endpoint that writes it
-- keeps working either way because the write is inside the transaction that
-- already emitted the event.
--
-- The partial unique index and the CHECK constraint are the guarantees; the
-- application checks that mirror them are a courtesy. Prisma expresses neither.

CREATE TYPE "DeletionRequestStatus" AS ENUM ('PENDING', 'ERASED', 'CANCELLED');

CREATE TABLE "account_deletion_requests" (
  "id"            UUID                    NOT NULL,
  "user_id"       UUID                    NOT NULL,
  "status"        "DeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requested_at"  TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scheduled_for" TIMESTAMP(3)            NOT NULL,
  "erased_at"     TIMESTAMP(3),
  "cancelled_at"  TIMESTAMP(3),

  CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "account_deletion_requests_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The job's only query: due rows, oldest promise first.
CREATE INDEX "ix_deletion_requests_due"
  ON "account_deletion_requests" ("status", "scheduled_for");

-- One open request per user. A second request while one is pending is the same
-- request, not a second one — and without this, two rows would both come due and
-- the second would erase an already-erased account, emitting a duplicate audit
-- event for an erasure that happened once.
CREATE UNIQUE INDEX "uq_deletion_requests_one_pending"
  ON "account_deletion_requests" ("user_id")
  WHERE "status" = 'PENDING';

-- A status and its timestamp are one fact written in two columns, so the
-- database owns the agreement rather than every future caller remembering it.
-- `ERASED` without `erased_at` would make the compliance question "when was this
-- discharged?" unanswerable by the only table that claims to answer it.
ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "ck_deletion_requests_status_timestamps" CHECK (
    ("status" = 'PENDING'   AND "erased_at" IS NULL     AND "cancelled_at" IS NULL) OR
    ("status" = 'ERASED'    AND "erased_at" IS NOT NULL AND "cancelled_at" IS NULL) OR
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "erased_at" IS NULL)
  );

-- The window is never negative: a request cannot come due before it was made.
ALTER TABLE "account_deletion_requests"
  ADD CONSTRAINT "ck_deletion_requests_window" CHECK ("scheduled_for" >= "requested_at");
