-- Payout/settlement Option A. Forward-only, no table or column dropped.
--
-- Purpose: `driver_settlements.status` and `driver_payouts.status` were bare
-- TEXT columns with no constraint. Three separate code paths wrote 'PAID'
-- without any money having moved. This migration turns both into real
-- PostgreSQL enums, and corrects the historical rows that assert a payment
-- that never happened.

-- ============================================================================
-- Enum types
-- ============================================================================

CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED');
CREATE TYPE "PayoutStatus" AS ENUM ('INITIATED', 'COMPLETED', 'FAILED');

-- ============================================================================
-- driver_payouts
-- ============================================================================

ALTER TABLE "driver_payouts"
  ADD COLUMN IF NOT EXISTS "external_reference" TEXT;

-- Any status this table has ever written ('INITIATED' | 'COMPLETED' |
-- 'FAILED') is already a member of the new type. Anything else is data we do
-- not recognise and must not silently coerce to a success value, so it lands
-- on FAILED — the only non-money-moving terminal state.
ALTER TABLE "driver_payouts"
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "driver_payouts"
  ALTER COLUMN "status" TYPE "PayoutStatus"
  USING (
    CASE upper("status")
      WHEN 'INITIATED' THEN 'INITIATED'
      WHEN 'PROCESSING' THEN 'INITIATED'
      WHEN 'PENDING' THEN 'INITIATED'
      WHEN 'COMPLETED' THEN 'COMPLETED'
      ELSE 'FAILED'
    END
  )::"PayoutStatus";

ALTER TABLE "driver_payouts"
  ALTER COLUMN "status" SET DEFAULT 'INITIATED';

CREATE INDEX IF NOT EXISTS "driver_payouts_settlement_id_idx"
  ON "driver_payouts" ("settlement_id");

-- ============================================================================
-- driver_settlements
-- ============================================================================

ALTER TABLE "driver_settlements"
  ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "driver_settlements"
  ALTER COLUMN "status" TYPE "SettlementStatus"
  USING (
    CASE upper("status")
      WHEN 'PENDING' THEN 'PENDING'
      WHEN 'APPROVED' THEN 'APPROVED'
      WHEN 'PROCESSING' THEN 'PROCESSING'
      WHEN 'PAID' THEN 'PAID'
      WHEN 'FAILED' THEN 'FAILED'
      ELSE 'PENDING'
    END
  )::"SettlementStatus";

ALTER TABLE "driver_settlements"
  ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- ----------------------------------------------------------------------------
-- Correct the historical false PAIDs.
--
-- Before this change `SettlementService.calculateSettlement` set PAID in the
-- same transaction that created the row, and admin batch completion set PAID
-- across every child settlement — in both cases with no payout and no money
-- movement. Those rows are not paid. They are approved and awaiting payout.
--
-- A settlement keeps PAID only if COMPLETED payouts actually cover its
-- net_payable. Nothing is moved in the other direction: this never promotes a
-- row to PAID.
-- ----------------------------------------------------------------------------

UPDATE "driver_settlements" s
SET "status" = 'APPROVED'
WHERE s."status" = 'PAID'
  AND COALESCE(
        (
          SELECT SUM(p."amount")
          FROM "driver_payouts" p
          WHERE p."settlement_id" = s."id"
            AND p."status" = 'COMPLETED'
        ),
        0
      ) < s."net_payable";
