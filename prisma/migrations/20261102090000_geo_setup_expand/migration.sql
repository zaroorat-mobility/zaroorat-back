-- Geographic setup, expand step. Additive only: the previous application version
-- is still running while this applies (constitution 16.2) and reads none of it.

-- CreateEnum
CREATE TYPE "CityCoverageMode" AS ENUM ('WHOLE_CITY', 'ZONES_ONLY');

-- AlterEnum
-- Not used by this migration, and no row may hold it until a release after this
-- one: the previous application's Prisma client fails on an enum value it does
-- not know.
ALTER TYPE "ServiceZoneType" ADD VALUE IF NOT EXISTS 'SURGE';

-- AlterTable
ALTER TABLE "cities"
  ADD COLUMN "coverage_mode" "CityCoverageMode" NOT NULL DEFAULT 'WHOLE_CITY',
  ADD COLUMN "max_surge_multiplier" DECIMAL(4,2) NOT NULL DEFAULT 2.00;

-- AlterTable
ALTER TABLE "service_zones"
  ADD COLUMN "rider_message" TEXT;

-- AlterTable
ALTER TABLE "surge_windows"
  ADD COLUMN "city_code" TEXT,
  ADD COLUMN "days_of_week" SMALLINT[] NOT NULL DEFAULT ARRAY[]::SMALLINT[],
  ADD COLUMN "vehicle_type_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ALTER COLUMN "source" SET DEFAULT 'MANUAL';

-- CreateIndex
CREATE INDEX "surge_windows_city_code_starts_at_idx" ON "surge_windows"("city_code", "starts_at");

-- backfill:start
-- Every city keeps the behaviour it has today. A city with an active SERVICE or
-- AIRPORT zone already refuses pickups outside its zones, so it says so now.
UPDATE "cities" c SET "coverage_mode" = 'ZONES_ONLY'
WHERE EXISTS (
  SELECT 1 FROM "service_zones" z
  WHERE z."city_id" = c."id" AND z."is_active" AND z."zone_type" IN ('SERVICE', 'AIRPORT')
);

UPDATE "surge_windows" SET "vehicle_type_ids" = ARRAY["vehicle_type_id"]
WHERE "vehicle_type_id" IS NOT NULL;

-- Nothing has ever computed a surge from demand, so no row is really dynamic.
UPDATE "surge_windows" SET "source" = 'MANUAL' WHERE "source" = 'DYNAMIC';
-- backfill:end
