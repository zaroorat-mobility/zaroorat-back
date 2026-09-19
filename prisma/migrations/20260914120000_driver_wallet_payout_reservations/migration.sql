-- Option A safety hotfix (D12): driver payout reservations.
-- Data + one CHECK constraint. No table or column is added, renamed or dropped.
--
-- From this release an INITIATED driver payout reserves its amount in
-- driver_wallets.locked_balance, and every payout is checked against
-- available balance = balance - locked_balance. Nothing else writes
-- driver_wallets.locked_balance (it was always 0 before this), so the
-- back-fill below can set it outright.

-- 1. Back-fill. Payouts left INITIATED by the previous release were created
--    without a reservation. Record them now, so confirming or failing one
--    releases a reservation that actually exists.
UPDATE "driver_wallets" w
SET "locked_balance" = COALESCE(
  (
    SELECT SUM(p."amount")
    FROM "driver_payouts" p
    WHERE p."driver_id" = w."driver_id"
      AND p."status" = 'INITIATED'
  ),
  0
);

-- 2. A reservation can never be negative. Releasing or spending more than was
--    reserved is a bug; this makes the database refuse it instead of storing
--    a negative hold that would silently inflate the available balance.
--    There is deliberately NO locked_balance <= balance constraint: an
--    approved cash-ride clawback may legitimately drive balance below the
--    amount already reserved (Option B decision D11 handles that state).
ALTER TABLE "driver_wallets"
  ADD CONSTRAINT "driver_wallets_locked_balance_non_negative"
  CHECK ("locked_balance" >= 0);
