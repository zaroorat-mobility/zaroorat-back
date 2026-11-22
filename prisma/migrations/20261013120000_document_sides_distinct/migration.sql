-- A document's back is never the same file as its front. The application refuses it
-- (DOCUMENT_BACK_IS_FRONT); this holds it for every writer. Separate files across rows and
-- columns are serialised by the file row lock taken when a file is attached.
--
-- NOT VALID, then VALIDATE: adding the constraint takes only a brief lock, and validation
-- scans without blocking writes. Existing rows pass — back_file_id is new and NULL on every
-- row written before it.
ALTER TABLE "driver_documents"
  ADD CONSTRAINT "driver_documents_back_file_not_front"
  CHECK ("back_file_id" IS NULL OR "back_file_id" <> "file_id") NOT VALID;
ALTER TABLE "driver_documents" VALIDATE CONSTRAINT "driver_documents_back_file_not_front";

ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_back_file_not_front"
  CHECK ("back_file_id" IS NULL OR "back_file_id" <> "file_id") NOT VALID;
ALTER TABLE "vehicle_documents" VALIDATE CONSTRAINT "vehicle_documents_back_file_not_front";
