-- AlterTable
ALTER TABLE "surge_windows"
  ADD COLUMN "demand_threshold_pct" DECIMAL(5,2),
  ADD COLUMN "supply_threshold_pct" DECIMAL(5,2),
  ADD COLUMN "peak_hour_start" TEXT,
  ADD COLUMN "peak_hour_end" TEXT,
  ADD COLUMN "is_peak_hour_only" BOOLEAN NOT NULL DEFAULT false;
