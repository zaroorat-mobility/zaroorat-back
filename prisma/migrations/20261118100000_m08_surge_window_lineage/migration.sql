-- Phase 2 · Migration M-08: Surge Disclosure & End-and-Replace Window Lineage
-- Expand-only and backward-compatible with older application versions.

ALTER TABLE "surge_windows"
  ADD COLUMN IF NOT EXISTS "supersedes_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "created_by" UUID NULL,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE "surge_windows"
  ADD CONSTRAINT "surge_windows_supersedes_id_fkey"
  FOREIGN KEY ("supersedes_id") REFERENCES "surge_windows"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "surge_windows"
SET "updated_at" = COALESCE("created_at", now())
WHERE "updated_at" IS NULL;

CREATE INDEX IF NOT EXISTS "surge_windows_supersedes_id_idx"
  ON "surge_windows" ("supersedes_id");

ALTER TABLE "ride_requests"
  ADD COLUMN IF NOT EXISTS "surge_window_id" UUID NULL;

ALTER TABLE "ride_requests"
  ADD CONSTRAINT "ride_requests_surge_window_id_fkey"
  FOREIGN KEY ("surge_window_id") REFERENCES "surge_windows"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ride_requests_surge_window_id_idx"
  ON "ride_requests" ("surge_window_id");
