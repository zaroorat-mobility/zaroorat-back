-- Driver mobile app integration gaps (Phases 6b–13).
-- Additive only: new enum values/type, nullable columns, indexes, ScheduledRide.driverId.

-- ============================================================================
-- Ride early-end reason (Phase 6b)
-- ============================================================================

CREATE TYPE "RideEndReason" AS ENUM (
  'RIDER_REQUESTED_END',
  'DESTINATION_CHANGED',
  'RIDER_STOP_HERE',
  'SAFETY_CONCERN',
  'VEHICLE_BREAKDOWN',
  'ACCIDENT',
  'MEDICAL_EMERGENCY',
  'ROAD_BLOCKED',
  'RIDER_BEHAVIOUR',
  'UNABLE_TO_CONTINUE',
  'OTHER'
);

ALTER TABLE "rides"
  ADD COLUMN IF NOT EXISTS "early_end_reason_code" "RideEndReason",
  ADD COLUMN IF NOT EXISTS "early_end_reason_text" TEXT;

-- Phase 7: earnings queries by driver + completed_at
CREATE INDEX IF NOT EXISTS "rides_driver_id_completed_at_idx"
  ON "rides" ("driver_id", "completed_at");

-- ============================================================================
-- Scheduled rides: assignable driver + reminder sweep indexes (Phase 8)
-- ============================================================================

ALTER TABLE "scheduled_rides"
  ADD COLUMN IF NOT EXISTS "driver_id" UUID,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_rides_driver_id_fkey'
  ) THEN
    ALTER TABLE "scheduled_rides"
      ADD CONSTRAINT "scheduled_rides_driver_id_fkey"
      FOREIGN KEY ("driver_id") REFERENCES "drivers" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "scheduled_rides_driver_id_scheduled_for_idx"
  ON "scheduled_rides" ("driver_id", "scheduled_for");

CREATE INDEX IF NOT EXISTS "scheduled_rides_status_scheduled_for_reminder_sent_at_idx"
  ON "scheduled_rides" ("status", "scheduled_for", "reminder_sent_at");
