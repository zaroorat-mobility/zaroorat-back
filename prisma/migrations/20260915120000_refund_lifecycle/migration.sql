-- Phase 1: refund lifecycle. Additive only; every existing refund row is kept
-- exactly as it is (historical rows simply have no purpose recorded).

ALTER TABLE "refunds"
  ADD COLUMN "purpose" TEXT,
  ADD COLUMN "provider_payment_id" TEXT,
  ADD COLUMN "reserved_at" TIMESTAMP(3),
  ADD COLUMN "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_dispatch_at" TIMESTAMP(3),
  ADD COLUMN "last_dispatch_error" TEXT,
  ADD COLUMN "failed_at" TIMESTAMP(3),
  ADD COLUMN "failure_reason" TEXT;

-- One provider refund can back at most one of our refund rows.
CREATE UNIQUE INDEX "refunds_gateway_refund_id_key" ON "refunds" ("gateway_refund_id");

-- RefundReconciliationJob's scan: PROCESSING rows by last dispatch attempt.
CREATE INDEX "refunds_status_last_dispatch_at_idx" ON "refunds" ("status", "last_dispatch_at");
