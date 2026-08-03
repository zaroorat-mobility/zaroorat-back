-- FILES module, phase 1 (files doc 01 §12, doc 03 §7.1).
--
-- Additive only: creates two enums and one table, touches nothing existing. Safe
-- under a rolling deploy with no coordination — old code simply never queries it.
--
-- The four CHECK constraints and two partial indexes below are the guarantees;
-- the application checks that mirror them are a courtesy. Prisma expresses none
-- of them, so they live here (doc 03 §4), exactly as `uq_saved_places_user_label`
-- did for USER.

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "FilePurpose" AS ENUM (
  'PROFILE_IMAGE',
  'DRIVER_DOCUMENT',
  'VEHICLE_DOCUMENT',
  'VEHICLE_IMAGE',
  'SOS_EVIDENCE',
  'DISPUTE_EVIDENCE'
);

CREATE TYPE "FileStatus" AS ENUM (
  'PENDING',
  'READY',
  'EXPIRED',
  'DELETED',
  'SUPERSEDED'
);

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE "files" (
  "id"                UUID          NOT NULL,
  "owner_user_id"     UUID          NOT NULL,
  "purpose"           "FilePurpose" NOT NULL,
  "status"            "FileStatus"  NOT NULL DEFAULT 'PENDING',
  "storage_key"       TEXT          NOT NULL,
  "storage_provider"  TEXT          NOT NULL,
  "file_name"         TEXT          NOT NULL,
  "content_type"      TEXT          NOT NULL,
  "size_bytes"        INTEGER       NOT NULL,
  "checksum_sha256"   TEXT,
  "upload_expires_at" TIMESTAMP(3)  NOT NULL,
  "completed_at"      TIMESTAMP(3),
  "created_at"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3)  NOT NULL,
  "deleted_at"        TIMESTAMP(3),
  "archived_at"       TIMESTAMP(3),
  "erased_at"         TIMESTAMP(3),
  "superseded_by_id"  UUID,

  CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "files"
  ADD CONSTRAINT "files_owner_user_id_fkey"
  FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Self-reference forming the version chain (R-FILE-31).
ALTER TABLE "files"
  ADD CONSTRAINT "files_superseded_by_id_fkey"
  FOREIGN KEY ("superseded_by_id") REFERENCES "files" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- Everything in this block is what Prisma derives from the schema; it is written
-- out because a migration must be self-contained, and it matches
-- `prisma migrate diff --from-empty --to-schema` exactly.

-- §4.1 FILE-INV-1. Total, not partial: a key must stay unique across erased rows
-- too, or a stale signed URL could resolve to somebody else's object.
CREATE UNIQUE INDEX "uq_files_storage_key" ON "files" ("storage_key");

-- FILE-INV-8. A version chain is a line, not a tree: two files cannot name the
-- same successor. Postgres treats NULLs as distinct, so every current file
-- (successor NULL) coexists freely.
CREATE UNIQUE INDEX "files_superseded_by_id_key" ON "files" ("superseded_by_id");

-- Ownership scoping (FILE-INV-4).
CREATE INDEX "ix_files_owner" ON "files" ("owner_user_id");

-- Non-partial companions for the owner-scoped reads; the partial forms below
-- serve the two jobs.
CREATE INDEX "ix_files_sweep" ON "files" ("status", "upload_expires_at");
CREATE INDEX "ix_files_retention" ON "files" ("status", "deleted_at");

-- ── Beyond Prisma ────────────────────────────────────────────────────────────
-- Everything from here down is invisible to the Prisma schema: partial indexes
-- and CHECK constraints, neither of which Prisma can express. Same arrangement
-- as `uq_saved_places_user_label` in the USER migration.

-- §4.2 The sweeper only ever asks one question. A partial index keeps the scan
-- proportional to the orphan backlog rather than to the table (R-FILE-22).
CREATE INDEX "ix_files_sweep_pending" ON "files" ("upload_expires_at")
  WHERE "status" = 'PENDING';

-- §4.6 The retention job's query, matching 09 §4.2 exactly. Without the
-- predicate it scans every file ever uploaded, nightly, forever.
CREATE INDEX "ix_files_retention_pending" ON "files" ("deleted_at")
  WHERE ("deleted_at" IS NOT NULL OR "status" = 'SUPERSEDED')
    AND "erased_at" IS NULL
    AND "archived_at" IS NULL;

-- §4.4 One live profile image per user. This is what makes "replacing an avatar
-- replaces it" a database fact: the old row must leave READY in the same
-- transaction that readies the new one, or the insert fails.
CREATE UNIQUE INDEX "uq_files_one_live_profile_image" ON "files" ("owner_user_id")
  WHERE "purpose" = 'PROFILE_IMAGE' AND "status" = 'READY' AND "deleted_at" IS NULL;

-- ── Checks ───────────────────────────────────────────────────────────────────

-- §4.3 A READY file has been verified, so it must carry the evidence of
-- completion. This is what makes FILE-INV-3 structural: "attach only READY
-- files" cannot be satisfied by forging a state.
ALTER TABLE "files" ADD CONSTRAINT "ck_files_ready_is_complete"
  CHECK ("status" <> 'READY' OR ("completed_at" IS NOT NULL AND "size_bytes" > 0));

-- A retention terminal outcome implies the row already left the read path.
ALTER TABLE "files" ADD CONSTRAINT "ck_files_terminal_implies_closed"
  CHECK (("erased_at" IS NULL AND "archived_at" IS NULL)
         OR "deleted_at" IS NOT NULL
         OR "status" = 'SUPERSEDED');

-- FILE-INV-9. Archive and erase are opposite outcomes, never both — this is what
-- makes the `action` field in `file.erased` trustworthy (05 §3.5).
ALTER TABLE "files" ADD CONSTRAINT "ck_files_archive_xor_erase"
  CHECK ("archived_at" IS NULL OR "erased_at" IS NULL);

-- FILE-INV-8. A superseded file must name its replacement, and only a superseded
-- file may.
ALTER TABLE "files" ADD CONSTRAINT "ck_files_superseded_has_successor"
  CHECK (("status" = 'SUPERSEDED') = ("superseded_by_id" IS NOT NULL));
