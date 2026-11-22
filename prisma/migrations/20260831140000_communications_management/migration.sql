-- AdminBroadcastStatus enum
CREATE TYPE "AdminBroadcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- Extend notification_templates for admin communications management
ALTER TABLE "notification_templates" ADD COLUMN IF NOT EXISTS "event_key" TEXT;
ALTER TABLE "notification_templates" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "notification_templates" ADD COLUMN IF NOT EXISTS "variables" JSONB;

UPDATE "notification_templates"
SET
  "event_key" = COALESCE("event_key", "code"),
  "subject" = COALESCE("subject", "title_template")
WHERE "event_key" IS NULL OR "subject" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "notification_templates_channel_event_key_key"
  ON "notification_templates"("channel", "event_key")
  WHERE "event_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "notification_templates_channel_is_active_idx"
  ON "notification_templates"("channel", "is_active");

-- Extend notification_deliveries for admin delivery history
ALTER TABLE "notification_deliveries" ALTER COLUMN "notification_id" DROP NOT NULL;

ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "template_id" UUID;
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "recipient" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "failure_reason" TEXT;
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "opened_at" TIMESTAMP(3);
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

UPDATE "notification_deliveries"
SET "recipient" = COALESCE("recipient", "target")
WHERE "recipient" IS NULL AND "target" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "notification_deliveries_template_id_idx"
  ON "notification_deliveries"("template_id");

CREATE INDEX IF NOT EXISTS "notification_deliveries_channel_created_at_idx"
  ON "notification_deliveries"("channel", "created_at");

DO $$ BEGIN
  ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Admin push broadcasts
CREATE TABLE IF NOT EXISTS "admin_broadcasts" (
  "id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'PUSH',
  "targeting" JSONB,
  "status" "AdminBroadcastStatus" NOT NULL DEFAULT 'DRAFT',
  "scheduled_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "sent_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "total_recipients" INTEGER NOT NULL DEFAULT 0,
  "failure_reason" TEXT,
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "admin_broadcasts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "admin_broadcasts_status_scheduled_at_idx"
  ON "admin_broadcasts"("status", "scheduled_at");

CREATE INDEX IF NOT EXISTS "admin_broadcasts_channel_created_at_idx"
  ON "admin_broadcasts"("channel", "created_at");
