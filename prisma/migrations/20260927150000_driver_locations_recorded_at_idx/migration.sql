-- CreateIndex
CREATE INDEX IF NOT EXISTS "driver_locations_recorded_at_idx" ON "driver_locations"("recorded_at" DESC);
