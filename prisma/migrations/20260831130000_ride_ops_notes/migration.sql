-- Create Table ride_ops_notes
CREATE TABLE IF NOT EXISTS "ride_ops_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ride_id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "note" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ride_ops_notes_pkey" PRIMARY KEY ("id")
);

-- Create Indexes
CREATE INDEX IF NOT EXISTS "ride_ops_notes_ride_id_created_at_idx" ON "ride_ops_notes"("ride_id", "created_at");

-- Add Foreign Keys
DO $$ BEGIN
  ALTER TABLE "ride_ops_notes" ADD CONSTRAINT "ride_ops_notes_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "ride_ops_notes" ADD CONSTRAINT "ride_ops_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
