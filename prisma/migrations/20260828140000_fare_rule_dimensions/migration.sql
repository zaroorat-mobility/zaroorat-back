-- CreateEnum
CREATE TYPE "RideServiceType" AS ENUM ('INSTANT', 'SCHEDULED', 'RENTAL', 'OUTSTATION');

-- AlterTable
ALTER TABLE "pricing_rules" ADD COLUMN "service_type" "RideServiceType",
ADD COLUMN "service_zone_id" UUID,
ADD COLUMN "tax_rate_pct" DECIMAL(5,2),
ADD COLUMN "commission_rate_pct" DECIMAL(5,2);

-- CreateIndex
DROP INDEX IF EXISTS "pricing_rules_city_code_vehicle_type_id_idx";
CREATE INDEX "pricing_rules_city_code_vehicle_type_id_service_type_service_idx" ON "pricing_rules"("city_code", "vehicle_type_id", "service_type", "service_zone_id");

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_service_zone_id_fkey" FOREIGN KEY ("service_zone_id") REFERENCES "service_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
