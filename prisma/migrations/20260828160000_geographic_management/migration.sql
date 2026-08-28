-- CreateEnum
CREATE TYPE "ServiceZoneType" AS ENUM ('SERVICE', 'AIRPORT', 'RESTRICTED');

-- CreateTable
CREATE TABLE "countries" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "states" (
    "id" UUID NOT NULL,
    "country_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_zone_vehicle_types" (
    "service_zone_id" UUID NOT NULL,
    "vehicle_type_id" UUID NOT NULL,

    CONSTRAINT "service_zone_vehicle_types_pkey" PRIMARY KEY ("service_zone_id","vehicle_type_id")
);

-- AlterTable cities
ALTER TABLE "cities" ADD COLUMN "state_id" UUID,
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable service_zones
ALTER TABLE "service_zones"
ADD COLUMN "allows_pickup" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "allows_dropoff" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Migrate zone_type text -> enum
ALTER TABLE "service_zones" ADD COLUMN "zone_type_new" "ServiceZoneType";
UPDATE "service_zones" SET "zone_type_new" = CASE
  WHEN UPPER("zone_type") = 'AIRPORT' OR "code" LIKE '%AIRPORT%' THEN 'AIRPORT'::"ServiceZoneType"
  WHEN UPPER("zone_type") = 'RESTRICTED' THEN 'RESTRICTED'::"ServiceZoneType"
  ELSE 'SERVICE'::"ServiceZoneType"
END;
ALTER TABLE "service_zones" DROP COLUMN "zone_type";
ALTER TABLE "service_zones" RENAME COLUMN "zone_type_new" TO "zone_type";
ALTER TABLE "service_zones" ALTER COLUMN "zone_type" SET NOT NULL;
ALTER TABLE "service_zones" ALTER COLUMN "zone_type" SET DEFAULT 'SERVICE';

-- CreateIndex
CREATE UNIQUE INDEX "countries_code_key" ON "countries"("code");
CREATE INDEX "states_country_id_idx" ON "states"("country_id");
CREATE UNIQUE INDEX "states_country_id_code_key" ON "states"("country_id", "code");
CREATE INDEX "cities_state_id_idx" ON "cities"("state_id");
CREATE UNIQUE INDEX "service_zones_city_id_code_key" ON "service_zones"("city_id", "code");
CREATE INDEX "service_zones_city_id_zone_type_idx" ON "service_zones"("city_id", "zone_type");

-- AddForeignKey
ALTER TABLE "states" ADD CONSTRAINT "states_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cities" ADD CONSTRAINT "cities_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "states"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_zone_vehicle_types" ADD CONSTRAINT "service_zone_vehicle_types_service_zone_id_fkey" FOREIGN KEY ("service_zone_id") REFERENCES "service_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_zone_vehicle_types" ADD CONSTRAINT "service_zone_vehicle_types_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
