-- Promo banners: image URL → Files-module imageFileId (PROMO_BANNER purpose).

ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'PROMO_BANNER';

ALTER TABLE "promo_banners" ADD COLUMN IF NOT EXISTS "image_file_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'promo_banners_image_file_id_key'
  ) THEN
    CREATE UNIQUE INDEX "promo_banners_image_file_id_key" ON "promo_banners" ("image_file_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promo_banners_image_file_id_fkey'
  ) THEN
    ALTER TABLE "promo_banners"
      ADD CONSTRAINT "promo_banners_image_file_id_fkey"
      FOREIGN KEY ("image_file_id") REFERENCES "files" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Dev/staging rows used placeholder URLs; drop the column once file ids are seeded.
ALTER TABLE "promo_banners" DROP COLUMN IF EXISTS "image_url";

DELETE FROM "promo_banners" WHERE "image_file_id" IS NULL;

ALTER TABLE "promo_banners" ALTER COLUMN "image_file_id" SET NOT NULL;
