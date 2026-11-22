-- Finance admin ops: reconciliation fields, refund workflow, settlement batches, payment disputes

ALTER TABLE "payment_transactions"
  ADD COLUMN IF NOT EXISTS "variance_status" TEXT,
  ADD COLUMN IF NOT EXISTS "reconciled_by" TEXT,
  ADD COLUMN IF NOT EXISTS "last_reconciled_at" TIMESTAMP(3);

ALTER TABLE "refunds"
  ADD COLUMN IF NOT EXISTS "display_code" TEXT,
  ADD COLUMN IF NOT EXISTS "refund_type" TEXT,
  ADD COLUMN IF NOT EXISTS "workflow_status" TEXT NOT NULL DEFAULT 'requested',
  ADD COLUMN IF NOT EXISTS "approval_level" TEXT,
  ADD COLUMN IF NOT EXISTS "refund_source" TEXT,
  ADD COLUMN IF NOT EXISTS "dispute_id" UUID,
  ADD COLUMN IF NOT EXISTS "reviewed_by" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processed_by" TEXT,
  ADD COLUMN IF NOT EXISTS "admin_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "timeline" JSONB,
  ADD COLUMN IF NOT EXISTS "rider_name" TEXT;

CREATE INDEX IF NOT EXISTS "refunds_workflow_status_created_at_idx"
  ON "refunds"("workflow_status", "created_at");

CREATE TABLE IF NOT EXISTS "settlement_batches" (
  "id" UUID NOT NULL,
  "batch_number" TEXT NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "generated_by" TEXT NOT NULL,
  "processed_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "total_drivers" INTEGER NOT NULL DEFAULT 0,
  "total_gross_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_commission" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_refund_adjustments" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_penalties" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_bonuses" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_net_payable" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "timeline" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "settlement_batches_batch_number_key"
  ON "settlement_batches"("batch_number");

CREATE INDEX IF NOT EXISTS "settlement_batches_period_start_period_end_idx"
  ON "settlement_batches"("period_start", "period_end");

CREATE INDEX IF NOT EXISTS "settlement_batches_status_created_at_idx"
  ON "settlement_batches"("status", "created_at");

ALTER TABLE "driver_settlements"
  ADD COLUMN IF NOT EXISTS "settlement_batch_id" UUID;

CREATE INDEX IF NOT EXISTS "driver_settlements_settlement_batch_id_idx"
  ON "driver_settlements"("settlement_batch_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'driver_settlements_settlement_batch_id_fkey'
  ) THEN
    ALTER TABLE "driver_settlements"
      ADD CONSTRAINT "driver_settlements_settlement_batch_id_fkey"
      FOREIGN KEY ("settlement_batch_id") REFERENCES "settlement_batches"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "payment_disputes" (
  "id" UUID NOT NULL,
  "ride_id" UUID NOT NULL,
  "complaint_id" UUID,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "rider_user_id" UUID NOT NULL,
  "rider_name" TEXT NOT NULL,
  "driver_id" UUID NOT NULL,
  "driver_name" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "requested_amount" DECIMAL(10,2),
  "reason" TEXT NOT NULL,
  "assigned_to" TEXT,
  "assigned_at" TIMESTAMP(3),
  "resolved_by" TEXT,
  "resolved_at" TIMESTAMP(3),
  "resolution_type" TEXT,
  "resolution_notes" TEXT,
  "adjustment_amount" DECIMAL(10,2),
  "version" INTEGER NOT NULL DEFAULT 1,
  "timeline" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "payment_disputes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payment_disputes_status_created_at_idx"
  ON "payment_disputes"("status", "created_at");

CREATE INDEX IF NOT EXISTS "payment_disputes_ride_id_idx"
  ON "payment_disputes"("ride_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payment_disputes_ride_id_fkey'
  ) THEN
    ALTER TABLE "payment_disputes"
      ADD CONSTRAINT "payment_disputes_ride_id_fkey"
      FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
