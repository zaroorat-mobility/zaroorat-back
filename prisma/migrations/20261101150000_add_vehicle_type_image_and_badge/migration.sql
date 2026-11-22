-- AlterTable: Add dynamic fleet catalog fields to vehicle_types
ALTER TABLE "vehicle_types" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'car';
ALTER TABLE "vehicle_types" ADD COLUMN IF NOT EXISTS "has_ac" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "vehicle_types" ADD COLUMN IF NOT EXISTS "badge" TEXT;
ALTER TABLE "vehicle_types" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "vehicle_types" ADD COLUMN IF NOT EXISTS "image_url" TEXT;
ALTER TABLE "vehicle_types" ADD COLUMN IF NOT EXISTS "image_file_id" UUID;
ALTER TABLE "vehicle_types" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_types_image_file_id_fkey'
  ) THEN
    ALTER TABLE "vehicle_types" ADD CONSTRAINT "vehicle_types_image_file_id_fkey"
    FOREIGN KEY ("image_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

