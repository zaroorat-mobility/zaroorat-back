-- Create Safety Incident Enums
DO $$ BEGIN
  CREATE TYPE "SafetyIncidentType" AS ENUM ('SOS', 'MISCONDUCT', 'ACCIDENT', 'LOST_FOUND', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SafetyIncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SafetySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create Table safety_incidents
CREATE TABLE IF NOT EXISTS "safety_incidents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "incident_number" TEXT NOT NULL,
  "type" "SafetyIncidentType" NOT NULL DEFAULT 'SOS',
  "severity" "SafetySeverity" NOT NULL DEFAULT 'HIGH',
  "status" "SafetyIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "ride_id" UUID,
  "reporter_user_id" UUID NOT NULL,
  "subject_user_id" UUID,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "location_address" TEXT,
  "description" TEXT,
  "acknowledged_at" TIMESTAMP(3),
  "acknowledged_by" UUID,
  "resolved_at" TIMESTAMP(3),
  "resolved_by" UUID,
  "resolution_type" TEXT,
  "resolution_notes" TEXT,
  "evidence_file_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "safety_incidents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "safety_incidents_incident_number_key" ON "safety_incidents"("incident_number");
CREATE INDEX IF NOT EXISTS "safety_incidents_status_idx" ON "safety_incidents"("status");
CREATE INDEX IF NOT EXISTS "safety_incidents_type_idx" ON "safety_incidents"("type");
CREATE INDEX IF NOT EXISTS "safety_incidents_severity_idx" ON "safety_incidents"("severity");
CREATE INDEX IF NOT EXISTS "safety_incidents_ride_id_idx" ON "safety_incidents"("ride_id");
CREATE INDEX IF NOT EXISTS "safety_incidents_reporter_user_id_idx" ON "safety_incidents"("reporter_user_id");

DO $$ BEGIN
  ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create Table safety_incident_events
CREATE TABLE IF NOT EXISTS "safety_incident_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "incident_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "actor_id" UUID,
  "notes" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "safety_incident_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "safety_incident_events_incident_id_created_at_idx" ON "safety_incident_events"("incident_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "safety_incident_events" ADD CONSTRAINT "safety_incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "safety_incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "safety_incident_events" ADD CONSTRAINT "safety_incident_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
