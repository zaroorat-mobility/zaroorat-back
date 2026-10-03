-- CreateEnum
CREATE TYPE "StateDivisionType" AS ENUM ('STATE', 'UNION_TERRITORY');

-- AlterTable
ALTER TABLE "states"
ADD COLUMN "native_name" VARCHAR(150),
ADD COLUMN "division_type" "StateDivisionType" NOT NULL DEFAULT 'STATE',
ADD COLUMN "lgd_code" INTEGER,
ADD COLUMN "iso_code" VARCHAR(6),
ADD COLUMN "census_code" VARCHAR(4);

-- CreateIndex
CREATE UNIQUE INDEX "states_country_id_name_key" ON "states"("country_id", "name");
CREATE UNIQUE INDEX "states_country_id_lgd_code_key" ON "states"("country_id", "lgd_code");
CREATE INDEX "states_country_id_division_type_idx" ON "states"("country_id", "division_type");
