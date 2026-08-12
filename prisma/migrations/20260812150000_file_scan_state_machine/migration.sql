-- FILES: malware scanning and an explicit upload state machine.
--
-- Before this, a file went `PENDING → READY` the moment the client called
-- complete and the object was found in the bucket. Nothing scanned the bytes
-- for malware, so a signed read URL could hand a customer or an operator a file
-- that had never been checked.
--
-- The lifecycle is now:
--
--   PENDING → UPLOADED → SCANNING → VALIDATING → READY
--                          │            │
--                          └──▶ REJECTED ◀┘
--
-- and `scan_status` tracks the verdict separately, so "not scanned yet" can
-- never be mistaken for "scanned clean".
--
-- ## Backfill
--
-- Existing `READY` rows predate scanning. They are marked `SKIPPED` rather than
-- `CLEAN`: they were never scanned, and recording them as clean would be a
-- false statement in the audit trail. They stay readable — retroactively
-- breaking live avatars is worse than an honest label — and can be re-scanned
-- by re-uploading. Every other status keeps `PENDING`, which is the default and
-- is correct for rows that never completed.

-- New lifecycle states. Postgres requires each ADD VALUE separately, and they
-- cannot run inside the same transaction as a statement that *uses* them —
-- hence the backfill below refers only to pre-existing values.
ALTER TYPE "FileStatus" ADD VALUE IF NOT EXISTS 'UPLOADED';
ALTER TYPE "FileStatus" ADD VALUE IF NOT EXISTS 'SCANNING';
ALTER TYPE "FileStatus" ADD VALUE IF NOT EXISTS 'VALIDATING';
ALTER TYPE "FileStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FileScanStatus') THEN
    CREATE TYPE "FileScanStatus" AS ENUM ('PENDING', 'CLEAN', 'THREAT', 'FAILED', 'SKIPPED');
  END IF;
END
$$;

ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "scan_status" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "scanned_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "scan_threat" TEXT,
  ADD COLUMN IF NOT EXISTS "rejected_reason" TEXT;

-- Rows that were already serving reads before scanning existed. Labelled for
-- what actually happened to them: nothing.
UPDATE "files"
   SET "scan_status" = 'SKIPPED'
 WHERE "status" = 'READY'
   AND "scan_status" = 'PENDING';

-- The scan-result and validation workers both query "files stuck in a
-- non-terminal state", which is `(status, scan_status)`.
CREATE INDEX IF NOT EXISTS "ix_files_scan" ON "files" ("status", "scan_status");
