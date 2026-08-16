-- Storage and validation metadata the custody record was missing.
--
-- All five columns are nullable and additive. Existing rows keep NULL rather
-- than a guessed value: the bucket a historical object was written to is not
-- recoverable from the row, and inventing one would make a lookup fail in a way
-- that looks like data rather than absence.
--
--   storage_bucket        which bucket holds the object. Without it a bucket
--                         rename orphans every historical row.
--   storage_version_id    the S3 version the validated bytes live at, so
--                         erasure can prove it destroyed what it validated.
--   detected_content_type what the bytes actually are, decided server-side.
--                         `content_type` stays the client's claim.
--   uploaded_at           when the object was first observed in storage.
--   verified_at           when server-side content validation passed.
--
-- Idempotent, so a partially applied migration re-runs cleanly.

ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "storage_bucket" TEXT,
  ADD COLUMN IF NOT EXISTS "storage_version_id" TEXT,
  ADD COLUMN IF NOT EXISTS "detected_content_type" TEXT,
  ADD COLUMN IF NOT EXISTS "uploaded_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP(3);

-- The reconciliation job's query: rows still awaiting an outcome, oldest first.
-- Partial on the non-terminal states so it stays small as the table grows.
CREATE INDEX IF NOT EXISTS "ix_files_reconcile"
  ON "files" ("status", "created_at")
  WHERE "status" IN ('PENDING', 'UPLOADED');
