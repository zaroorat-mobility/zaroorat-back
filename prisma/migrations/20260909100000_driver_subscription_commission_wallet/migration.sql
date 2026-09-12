-- 004-driver-subscription-wallet. Additive, forward-only (constitution §3.2).
-- No existing table renamed/dropped, no existing column removed, no existing
-- row rewritten. See specs/004-driver-subscription-wallet/data-model.md.

-- ============================================================================
-- New tables
-- ============================================================================

CREATE TABLE "subscription_plans" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           TEXT NOT NULL,
  "billing_period" TEXT NOT NULL,
  "price"          DECIMAL(10,2) NOT NULL,
  "currency"       CHAR(3) NOT NULL DEFAULT 'INR',
  "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "subscription_plans_status_idx" ON "subscription_plans" ("status");

CREATE TABLE "driver_subscriptions" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "driver_id"        UUID NOT NULL,
  "plan_id"          UUID NOT NULL,
  "pending_plan_id"  UUID,
  "status"           TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  "payment_status"   TEXT NOT NULL DEFAULT 'PENDING',
  "auto_renew"       BOOLEAN NOT NULL DEFAULT true,
  "start_date"       TIMESTAMPTZ,
  "expiry_date"      TIMESTAMPTZ,
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
  "payment_intent_id" UUID,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "driver_subscriptions_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "driver_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "driver_subscriptions_driver_id_status_idx" ON "driver_subscriptions" ("driver_id", "status");
CREATE INDEX "driver_subscriptions_status_expiry_date_idx" ON "driver_subscriptions" ("status", "expiry_date");

-- decisions.md BD-6/data-model.md §4.1 — the DB-level backstop for "at most one
-- ACTIVE subscription per driver," mirroring 20260821130000_ride_active_uniqueness.
CREATE UNIQUE INDEX "driver_subscriptions_one_active"
  ON "driver_subscriptions" ("driver_id")
  WHERE "status" = 'ACTIVE';

CREATE TABLE "driver_commission_wallets" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "driver_id"           UUID NOT NULL UNIQUE,
  "balance"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  "currency"            CHAR(3) NOT NULL DEFAULT 'INR',
  "last_transaction_at" TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "driver_commission_wallets_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "driver_commission_wallet_transactions" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "wallet_id"      UUID NOT NULL,
  "driver_id"      UUID NOT NULL,
  "ride_id"        UUID,
  "txn_type"       TEXT NOT NULL,
  "amount"         DECIMAL(12,2) NOT NULL,
  "balance_after"  DECIMAL(12,2) NOT NULL,
  "reference_type" TEXT,
  "reference_id"   UUID,
  "description"    TEXT,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "driver_commission_wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "driver_commission_wallets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "driver_commission_wallet_transactions_ride_id_fkey" FOREIGN KEY ("ride_id") REFERENCES "rides" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "driver_commission_wallet_transactions_wallet_id_created_at_idx" ON "driver_commission_wallet_transactions" ("wallet_id", "created_at");
CREATE INDEX "driver_commission_wallet_transactions_driver_id_created_at_idx" ON "driver_commission_wallet_transactions" ("driver_id", "created_at");

-- decisions.md BD-1/data-model.md §4.2 — the idempotency guarantee behind
-- spec.md FR-021: at most one RIDE_COMMISSION deduction per ride, ever. A
-- retried/duplicated completion's second insert fails this constraint.
CREATE UNIQUE INDEX "commission_wallet_one_deduction_per_ride"
  ON "driver_commission_wallet_transactions" ("ride_id")
  WHERE "txn_type" = 'RIDE_COMMISSION';

CREATE TABLE "wallet_recharge_options" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "amount"     DECIMAL(12,2) NOT NULL,
  "label"      TEXT,
  "status"     TEXT NOT NULL DEFAULT 'ACTIVE',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "wallet_recharge_options_status_sort_order_idx" ON "wallet_recharge_options" ("status", "sort_order");

-- ============================================================================
-- Additive columns on existing tables
-- ============================================================================

-- `purpose` defaults to the existing behavior for every historical and any
-- not-yet-migrated row — IntentService.applyConfirmation's SUCCEEDED branch
-- dispatches on it additively; the CUSTOMER_WALLET_TOPUP path is unchanged.
ALTER TABLE "payment_intents" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'CUSTOMER_WALLET_TOPUP';

-- Nullable: a driver who has never chosen is unambiguously distinguishable
-- from one who has (spec.md Assumptions — no default model is silently
-- assigned).
ALTER TABLE "drivers" ADD COLUMN "payment_model" TEXT;
ALTER TABLE "drivers" ADD COLUMN "pending_payment_model" TEXT;

-- Nullable for migration safety — see the schema comment on Ride.driverPaymentModel
-- (prisma/schema/modules/ride/ride.prisma): NULL means "created before this
-- column existed," never an error condition. `commission_amount` was already
-- designed nullable (SUBSCRIPTION-model rides never populate it).
ALTER TABLE "rides" ADD COLUMN "driver_payment_model" TEXT;
ALTER TABLE "rides" ADD COLUMN "commission_amount" DECIMAL(12,2);
