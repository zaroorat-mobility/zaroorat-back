-- Phase 1: driver bank-account security foundation.
-- EXPAND step of expand -> backfill -> verify -> contract. Nothing is dropped
-- and no existing value is rewritten except the explicit, safety-only
-- normalisations below. The legacy PLAINTEXT "account_number_enc" column is
-- untouched here; it is encrypted into the new columns by the backfill script
-- and only cleared in a later, separately approved contract migration.

CREATE TYPE "BankAccountStatus" AS ENUM (
  'ENTERED', 'PROVISIONED', 'VERIFIED', 'PAYOUT_ENABLED', 'REJECTED', 'DEACTIVATED'
);

ALTER TABLE "driver_bank_accounts"
  ADD COLUMN "status" "BankAccountStatus" NOT NULL DEFAULT 'ENTERED',
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "account_number_ciphertext" TEXT,
  ADD COLUMN "account_number_last4" CHAR(4),
  ADD COLUMN "account_number_hash" TEXT,
  ADD COLUMN "encryption_key_version" SMALLINT,
  ADD COLUMN "entered_by" UUID,
  ADD COLUMN "status_reason" TEXT,
  ADD COLUMN "status_changed_at" TIMESTAMP(3),
  ADD COLUMN "status_changed_by" UUID,
  ADD COLUMN "payout_enabled_at" TIMESTAMP(3),
  ADD COLUMN "deactivated_at" TIMESTAMP(3);

-- Existing accounts enter the new lifecycle conservatively. A historical
-- verification_status of VERIFIED was set as a side effect of approving a
-- driver APPLICATION, not by any bank verification, so it does not carry over:
-- every existing account must pass the new, audited verification gate.
-- verification_status itself is left untouched as history.
UPDATE "driver_bank_accounts" SET "status" = 'REJECTED' WHERE "verification_status" = 'REJECTED';

-- No account may be payout-enabled without passing the new gate. (No code ever
-- set this true, so this is expected to touch zero rows.)
UPDATE "driver_bank_accounts" SET "payout_enabled" = false WHERE "payout_enabled" = true;

CREATE INDEX "driver_bank_accounts_account_number_hash_idx"
  ON "driver_bank_accounts" ("account_number_hash");

-- payout_enabled is true exactly when status = PAYOUT_ENABLED, and only on an
-- active account. Enforced by the database so no code path can drift from it.
ALTER TABLE "driver_bank_accounts"
  ADD CONSTRAINT "driver_bank_accounts_payout_enabled_matches_status"
  CHECK (("status" = 'PAYOUT_ENABLED') = "payout_enabled");
ALTER TABLE "driver_bank_accounts"
  ADD CONSTRAINT "driver_bank_accounts_payout_enabled_requires_active"
  CHECK (NOT "payout_enabled" OR "is_active");
