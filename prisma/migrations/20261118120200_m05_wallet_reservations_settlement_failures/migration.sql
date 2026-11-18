-- Phase 4 · Migration M-05: Wallet Transactions, Atomic Reservations, Settlement Steps & Failure Recovery
-- D-19 Option A: All monetary columns use DECIMAL(12, 2) matching existing wallet.prisma & payment.prisma.

-- (a) Validate allowed txn_type values on driver_commission_wallet_transactions (including RIDE_GST_RECOVERY)
ALTER TABLE "driver_commission_wallet_transactions"
  DROP CONSTRAINT IF EXISTS "driver_commission_wallet_transactions_txn_type_check";

ALTER TABLE "driver_commission_wallet_transactions"
  ADD CONSTRAINT "driver_commission_wallet_transactions_txn_type_check"
  CHECK ("txn_type" IN (
    'MANUAL_RECHARGE',
    'RIDE_COMMISSION',
    'RIDE_GST_RECOVERY',
    'REFUND',
    'REFUND_REVERSAL',
    'ADMIN_CREDIT',
    'ADMIN_DEBIT'
  )) NOT VALID;

-- (b) Partial unique index: at most ONE RIDE_GST_RECOVERY debit per ride, ever (mirrors RIDE_COMMISSION)
CREATE UNIQUE INDEX IF NOT EXISTS "commission_wallet_one_gst_recovery_per_ride"
  ON "driver_commission_wallet_transactions" ("ride_id")
  WHERE "txn_type" = 'RIDE_GST_RECOVERY';

-- (c) Atomic Driver Wallet Reservations (mandatory whenever commission or GST recovery deduction is ON)
CREATE TABLE "driver_wallet_reservations" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ride_id"               UUID NOT NULL UNIQUE REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "driver_id"             UUID NOT NULL REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "commission_amount"     DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("commission_amount" >= 0),
  "gst_recovery_amount"   DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("gst_recovery_amount" >= 0),
  "total_reserved_amount" DECIMAL(12, 2) NOT NULL CHECK ("total_reserved_amount" >= 0),
  "revision"              INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "status"                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolved_at"           TIMESTAMPTZ NULL,
  CONSTRAINT "driver_wallet_reservations_sum_check"
    CHECK ("total_reserved_amount" = "commission_amount" + "gst_recovery_amount")
);

CREATE INDEX "driver_wallet_reservations_driver_active_idx"
  ON "driver_wallet_reservations" ("driver_id")
  WHERE "status" = 'ACTIVE';

-- (d) Per-Ride Settlement Steps (tracks G1, G2, G3 independently; POSTED rows are immutable)
CREATE TABLE "ride_settlement_steps" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ride_id"         UUID NOT NULL REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "step_type"       TEXT NOT NULL CHECK ("step_type" IN (
    'COMMISSION_DEBIT', 'PASSENGER_GST_LIABILITY', 'GST_RECOVERY_DEBIT'
  )),
  "status"          TEXT NOT NULL CHECK ("status" IN (
    'POSTED',
    'FAILED_INSUFFICIENT_BALANCE',
    'WAIVED',
    'SKIPPED_DISABLED',
    'SKIPPED_GRANDFATHERED_SUBSCRIPTION',
    'SKIPPED_DRIVER_LIABLE'
  )),
  "ledger_group_id" UUID NULL,
  "wallet_txn_id"   UUID NULL REFERENCES "driver_commission_wallet_transactions"("id") ON DELETE RESTRICT,
  "amount"          DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("amount" >= 0),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ride_settlement_steps_ride_step_key" UNIQUE ("ride_id", "step_type")
);

CREATE INDEX "ride_settlement_steps_status_idx" ON "ride_settlement_steps" ("status", "step_type");

CREATE OR REPLACE FUNCTION enforce_ride_settlement_step_posted_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'POSTED' THEN
    RAISE EXCEPTION 'ride_settlement_steps row is immutable once status is POSTED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ride_settlement_steps_posted_immutable" ON "ride_settlement_steps";
CREATE TRIGGER "ride_settlement_steps_posted_immutable"
  BEFORE UPDATE OR DELETE ON "ride_settlement_steps"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ride_settlement_step_posted_immutable();

-- (e) Atomic Settlement Collection Failures & Recovery Tracking (Rev 5 R5-6)
CREATE TABLE "commission_collection_failures" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ride_id"                  UUID NOT NULL REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "driver_id"                UUID NOT NULL REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind"                     TEXT NOT NULL CHECK ("kind" IN ('COMMISSION', 'GST_RECOVERY')),
  "amount"                   DECIMAL(12, 2) NOT NULL CHECK ("amount" > 0),
  "balance_at_attempt"       DECIMAL(12, 2) NOT NULL,
  "status"                   TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN', 'RECOVERED', 'WAIVED')),
  "recovery_wallet_txn_id"   UUID NULL REFERENCES "driver_commission_wallet_transactions"("id") ON DELETE RESTRICT,
  "recovery_ledger_group_id" UUID NULL,
  "waiver_reason"            TEXT NULL,
  "resolved_by"              UUID NULL,
  "resolved_at"              TIMESTAMPTZ NULL,
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "commission_collection_failures_ride_kind_key" UNIQUE ("ride_id", "kind")
);

CREATE INDEX "commission_collection_failures_driver_status_idx"
  ON "commission_collection_failures" ("driver_id", "status");

-- (f) Guard against negative driver commission wallet balance on all new writes
ALTER TABLE "driver_commission_wallets"
  DROP CONSTRAINT IF EXISTS "driver_commission_wallets_non_negative_balance_check";

ALTER TABLE "driver_commission_wallets"
  ADD CONSTRAINT "driver_commission_wallets_non_negative_balance_check"
  CHECK ("balance" >= 0) NOT VALID;
