-- The back of a two-sided card (driving licence, Aadhaar, vehicle RC). `file_id` stays the
-- front. Additive and nullable: existing rows, one-sided documents and app versions that
-- send only the front keep working unchanged, so old and new instances can run side by side.
ALTER TABLE "driver_documents" ADD COLUMN "back_file_id" UUID;
ALTER TABLE "vehicle_documents" ADD COLUMN "back_file_id" UUID;

-- Same rules as `file_id`: a file backs at most one document side (NULLs stay distinct), and
-- RESTRICT so a file behind a live, possibly VERIFIED document cannot be removed under it.
CREATE UNIQUE INDEX "driver_documents_back_file_id_key"
  ON "driver_documents" ("back_file_id");
CREATE UNIQUE INDEX "vehicle_documents_back_file_id_key"
  ON "vehicle_documents" ("back_file_id");

ALTER TABLE "driver_documents"
  ADD CONSTRAINT "driver_documents_back_file_id_fkey"
  FOREIGN KEY ("back_file_id") REFERENCES "files" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_back_file_id_fkey"
  FOREIGN KEY ("back_file_id") REFERENCES "files" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
