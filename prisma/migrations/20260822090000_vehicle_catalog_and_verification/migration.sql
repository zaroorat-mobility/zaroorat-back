-- VEHICLES module — catalog rendering, vehicle verification, and the
-- file-reference cutover for vehicle documents.
--
-- Three related gaps, all in the vehicle domain, all required by the same
-- feature (a driver may only operate a verified vehicle, and a customer must
-- be able to render the category picker from server data). Nothing unrelated
-- is bundled in.

-- ---------------------------------------------------------------------------
-- 1. vehicle_types — catalog presentation
-- ---------------------------------------------------------------------------
-- `code` and `name` already carry identity and label; what a category picker
-- additionally needs and the table cannot express is which glyph to draw and
-- what order to draw the rows in. `display_order` is NOT NULL DEFAULT 0 so
-- existing rows keep a deterministic (code-tiebroken) order rather than NULL.
ALTER TABLE "vehicle_types" ADD COLUMN "icon" TEXT;
ALTER TABLE "vehicle_types"
  ADD COLUMN "display_order" SMALLINT NOT NULL DEFAULT 0;

-- The catalog endpoint's only query path: active types in display order.
CREATE INDEX "vehicle_types_is_active_display_order_idx"
  ON "vehicle_types" ("is_active", "display_order");

-- ---------------------------------------------------------------------------
-- 2. vehicles — verification state
-- ---------------------------------------------------------------------------
-- `is_active` answers "is this row usable", not "has an operator approved this
-- vehicle to carry passengers". Driver approval already has exactly this
-- distinction (drivers.verification_status alongside drivers.is_suspended);
-- vehicles had only the former, so a VERIFIED driver could operate a vehicle
-- nobody ever reviewed. Reuses the existing "VerificationStatus" enum rather
-- than introducing a parallel one.
--
-- DEFAULT 'PENDING' is deliberate for existing rows: a vehicle claimed before
-- this migration has, by definition, never been reviewed.
ALTER TABLE "vehicles"
  ADD COLUMN "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "vehicles" ADD COLUMN "verified_by" UUID;
ALTER TABLE "vehicles" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "vehicles" ADD COLUMN "rejection_reason" TEXT;

-- Admin review queue: "vehicles awaiting review".
CREATE INDEX "vehicles_verification_status_idx"
  ON "vehicles" ("verification_status");

-- ---------------------------------------------------------------------------
-- 3. vehicle_documents — file cutover + one row per (vehicle, type)
-- ---------------------------------------------------------------------------
-- Mirrors 20260820121500_driver_document_file_id and
-- 20260820120000_driver_documents_uniqueness exactly, for the same reasons.
--
-- `file_url` is a client-supplied string with no relationship to the Files
-- module: no ownership check, no purpose check, no proof the object exists.
-- `file_id` references a File row Files has already validated (READY, owned by
-- the caller, purpose = VEHICLE_DOCUMENT).
--
-- Expand only: file_url is loosened to nullable, NOT dropped. It is dropped in
-- a separate later migration once this has been live and nothing reads it.
ALTER TABLE "vehicle_documents" ALTER COLUMN "file_url" DROP NOT NULL;
ALTER TABLE "vehicle_documents" ADD COLUMN "file_id" UUID;

-- Review provenance, matching driver_documents column-for-column.
ALTER TABLE "vehicle_documents" ADD COLUMN "verified_by" UUID;
ALTER TABLE "vehicle_documents" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "vehicle_documents" ADD COLUMN "rejection_reason" TEXT;
ALTER TABLE "vehicle_documents"
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A file backs at most one live document row. NULLs are distinct in Postgres,
-- so pre-cutover rows with no file_id coexist freely.
CREATE UNIQUE INDEX "vehicle_documents_file_id_key"
  ON "vehicle_documents" ("file_id");

-- RESTRICT, not SET NULL: a file backing a live, possibly-VERIFIED document
-- must not be silently removable out from under it.
ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_file_id_fkey"
  FOREIGN KEY ("file_id") REFERENCES "files" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One document per (vehicle, document_type): re-submission updates the same
-- row rather than inserting a second one, and the repository is written as a
-- real upsert against this key in the same change.
--
-- Pre-deploy data check (run manually before applying):
--
--   SELECT vehicle_id, document_type, COUNT(*)
--   FROM vehicle_documents
--   GROUP BY vehicle_id, document_type
--   HAVING COUNT(*) > 1;
--
-- No code has ever written this table, so on any existing database this
-- returns nothing.
CREATE UNIQUE INDEX "vehicle_documents_vehicle_id_document_type_key"
  ON "vehicle_documents" ("vehicle_id", "document_type");
