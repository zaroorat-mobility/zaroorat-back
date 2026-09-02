-- Ride map provider pinning and sampled location breadcrumbs
ALTER TABLE "ride_requests" ADD COLUMN IF NOT EXISTS "map_provider" TEXT;
ALTER TABLE "ride_requests" ADD COLUMN IF NOT EXISTS "map_config_version" INTEGER;

ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "map_provider" TEXT;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "map_config_version" INTEGER;

CREATE TABLE IF NOT EXISTS "ride_location_points" (
  "id" UUID NOT NULL,
  "ride_id" UUID NOT NULL,
  "driver_id" UUID NOT NULL,
  "latitude" DECIMAL(10,7) NOT NULL,
  "longitude" DECIMAL(10,7) NOT NULL,
  "location" geography(Point, 4326) NOT NULL,
  "heading" DECIMAL(5,2),
  "speed_kmh" DECIMAL(6,2),
  "accuracy_meters" DECIMAL(8,2),
  "fix_id" TEXT NOT NULL,
  "sequence" INTEGER,
  "recorded_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ride_location_points_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ride_location_points_ride_id_fix_id_key"
  ON "ride_location_points"("ride_id", "fix_id");
CREATE INDEX IF NOT EXISTS "ride_location_points_ride_id_recorded_at_idx"
  ON "ride_location_points"("ride_id", "recorded_at");
CREATE INDEX IF NOT EXISTS "ride_location_points_recorded_at_idx"
  ON "ride_location_points"("recorded_at");

ALTER TABLE "ride_location_points"
  ADD CONSTRAINT "ride_location_points_ride_id_fkey"
  FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE CASCADE ON UPDATE CASCADE;
