-- 005-razorpay-driver-payments T020 (data-model.md §3, §5, §6, §7, §8; decisions.md TD-9,
-- TD-10, TD-17). Additive and forward-only.
--
-- PRE-CHECKS. Run read-only checks Q1–Q9 of data-model.md §12 on the target database first;
-- each must return zero rows, or carry a Finance-approved remediation (D-9). A non-zero
-- result makes the matching index below fail to build:
--   Q1 duplicate (gateway, gateway_intent_id)          -> payment_intents_gateway_intent_key
--   Q3 duplicate MANUAL_RECHARGE per reference_id      -> commission_wallet_one_credit_per_intent
--   Q4 duplicate SUCCEEDED PAYMENT (gateway, txn id)   -> payment_transactions_provider_payment_key
--   Q9 more than one SUCCEEDED PAYMENT per intent      -> payment_transactions_one_success_per_intent
--   Q2, Q5–Q8 are Finance remediation checks and block nothing here.
--
-- LARGE TABLES (constitution §3.4). CREATE INDEX here takes a lock that blocks writes while it
-- builds. Where a table is large, create the four partial unique indexes by hand first, with
-- the same names and definitions, using CREATE UNIQUE INDEX CONCURRENTLY outside a transaction;
-- the IF NOT EXISTS below then skips them.
--
-- NOT HERE. CHECK (balance >= 0) on driver_commission_wallets waits for Finance (D-2) and
-- follows in T020b. The gateway_events reliability columns and payment_intents.last_reconciled_at
-- (T019) are deferred to the tasks that use them (T026, T031, intent reconciliation).

-- 1. Review cases (§5).
CREATE TABLE "payment_review_cases" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "intent_id" UUID,
    "payment_transaction_id" UUID,
    "gateway" TEXT NOT NULL,
    "provider_payment_id" TEXT NOT NULL,
    "provider_order_id" TEXT,
    "expected_amount" DECIMAL(12,2),
    "observed_amount" DECIMAL(12,2) NOT NULL,
    "expected_currency" CHAR(3),
    "observed_currency" CHAR(3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "refund_id" UUID,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_review_cases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_review_cases_kind_check" CHECK ("kind" IN (
        'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'ORDER_MISMATCH', 'PAYMENT_ID_REUSED',
        'MULTIPLE_CAPTURES', 'UNMATCHED_CAPTURE', 'UNKNOWN_ORDER', 'EXTERNAL_REFUND')),
    CONSTRAINT "payment_review_cases_status_check" CHECK ("status" IN (
        'OPEN', 'RESOLVED_CREDIT', 'RESOLVED_REFUND', 'RESOLVED_NO_ACTION')),
    CONSTRAINT "payment_review_cases_intent_check" CHECK (
        "intent_id" IS NOT NULL OR "kind" = 'UNKNOWN_ORDER'),
    CONSTRAINT "payment_review_cases_resolution_check" CHECK (
        "status" = 'OPEN'
        OR ("resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL AND "resolution_note" IS NOT NULL))
);

CREATE UNIQUE INDEX "payment_review_cases_kind_provider_payment_id_key"
    ON "payment_review_cases"("kind", "provider_payment_id");
CREATE INDEX "payment_review_cases_status_created_at_idx"
    ON "payment_review_cases"("status", "created_at");

ALTER TABLE "payment_review_cases" ADD CONSTRAINT "payment_review_cases_intent_id_fkey"
    FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_review_cases" ADD CONSTRAINT "payment_review_cases_payment_transaction_id_fkey"
    FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_review_cases" ADD CONSTRAINT "payment_review_cases_refund_id_fkey"
    FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Reconciliation runs (§6).
CREATE TABLE "payment_reconciliation_runs" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "counts" JSONB,
    "error" TEXT,

    CONSTRAINT "payment_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_reconciliation_runs_job_finished_at_idx"
    ON "payment_reconciliation_runs"("job", "finished_at" DESC);

-- 3. Anchor indexes (§3, §7; TD-17). A duplicate effect fails at the database even if a lock
--    or a check is missed. Not expressible in the Prisma schema.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intents_gateway_intent_key"
    ON "payment_intents" ("gateway", "gateway_intent_id")
    WHERE "gateway_intent_id" IS NOT NULL;

-- INV-2: one applied-or-held record per provider payment.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_provider_payment_key"
    ON "payment_transactions" ("gateway", "gateway_txn_id")
    WHERE "txn_type" = 'PAYMENT' AND "status" IN ('SUCCEEDED', 'CAPTURED_REVIEW')
      AND "gateway_txn_id" IS NOT NULL;

-- INV-3: one successful payment per intent.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_one_success_per_intent"
    ON "payment_transactions" ("intent_id")
    WHERE "txn_type" = 'PAYMENT' AND "status" = 'SUCCEEDED';

-- INV-3: one wallet credit per recharge intent.
CREATE UNIQUE INDEX IF NOT EXISTS "commission_wallet_one_credit_per_intent"
    ON "driver_commission_wallet_transactions" ("reference_id")
    WHERE "txn_type" = 'MANUAL_RECHARGE';

-- 4. Append-only financial history (§8, TD-10). Same pattern as the audit tables
--    (20261001120000, 20261002130100): row triggers reuse reject_audit_mutation(); TRUNCATE is
--    refused unless the integration harness sets, transaction-locally,
--      SET LOCAL zaroorat.allow_financial_truncate = 'on'
--    A correction is a new entry, never an edit.
CREATE OR REPLACE FUNCTION reject_financial_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('zaroorat.allow_financial_truncate', true) = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: TRUNCATE refused', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER payment_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "payment_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER payment_ledger_entries_no_truncate
  BEFORE TRUNCATE ON "payment_ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_truncate();

CREATE TRIGGER driver_commission_wallet_transactions_append_only
  BEFORE UPDATE OR DELETE ON "driver_commission_wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER driver_commission_wallet_transactions_no_truncate
  BEFORE TRUNCATE ON "driver_commission_wallet_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_truncate();

ALTER TABLE "payment_ledger_entries" ENABLE ALWAYS TRIGGER payment_ledger_entries_append_only;
ALTER TABLE "payment_ledger_entries" ENABLE ALWAYS TRIGGER payment_ledger_entries_no_truncate;
ALTER TABLE "driver_commission_wallet_transactions"
  ENABLE ALWAYS TRIGGER driver_commission_wallet_transactions_append_only;
ALTER TABLE "driver_commission_wallet_transactions"
  ENABLE ALWAYS TRIGGER driver_commission_wallet_transactions_no_truncate;

-- 5. Privilege layer (TD-10). Effective only where the API connects through the runtime role
--    (SEC-7, check Q10). Tables created above get the runtime role's CRUD grant from the default
--    privileges set in 20261002130100.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zaroorat_app_runtime') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "payment_ledger_entries", "driver_commission_wallet_transactions"
      FROM zaroorat_app_runtime;
  END IF;
END
$$;
