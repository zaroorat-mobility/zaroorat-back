-- DRIVERS module — file-reference cutover, deploy 1 of 2 (plan.md §H.2, mirrors
-- the profile-image cutover in 20260803120000_profile_image_file_id).
--
-- `driver_documents.file_url` is a live, trusted, client-supplied URL with no
-- relationship to the Files module at all — no ownership check, no purpose
-- check, no proof the file was ever legitimately uploaded. This deploy adds
-- `file_id` as the real answer, referencing a `File` row the Files module has
-- already validated (READY, owned by the caller, purpose=DRIVER_DOCUMENT).
--
-- Expand only: `file_url` is loosened to nullable so new code can stop writing
-- it, but the column is NOT dropped here. It is dropped in a later, separate
-- migration once this has been live and confirmed nothing reads it — same
-- two-deploy shape as 20260803120000 → 20260804090000 for profile_image.

ALTER TABLE "driver_documents" ALTER COLUMN "file_url" DROP NOT NULL;

ALTER TABLE "driver_documents" ADD COLUMN "file_id" UUID;

-- A file may back at most one live document row (mirrors
-- user_profiles_profile_image_file_id_key exactly) — NULLs are distinct in
-- Postgres, so documents with no file_id yet (there should be none going
-- forward, but existing pre-cutover rows may have one) coexist freely.
CREATE UNIQUE INDEX "driver_documents_file_id_key"
  ON "driver_documents" ("file_id");

-- RESTRICT, not SET NULL: a file backing a live, possibly-VERIFIED document
-- must not be silently removable out from under it.
ALTER TABLE "driver_documents"
  ADD CONSTRAINT "driver_documents_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
