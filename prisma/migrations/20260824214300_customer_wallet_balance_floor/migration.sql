-- Customer wallet balance floor (FR-003).
--
-- A negative balance becomes REACHABLE FOR THE FIRST TIME with the wallet
-- debit path this feature adds, so the constraint ships with it rather than
-- after it. Application-level guards are the first line; this is the one that
-- survives a bug in them.
--
-- BACKWARD COMPATIBILITY: the currently deployed version has no debit path at
-- all, and its `hold` already refuses to lock more than (balance -
-- locked_balance). It therefore cannot violate either constraint.
--
-- PRE-FLIGHT (constitution 3.5 -- never assume a table is clean): verify
-- against the target database BEFORE deploying:
--
--   SELECT count(*) FROM "customer_wallets"
--    WHERE "balance" < 0 OR "locked_balance" < 0 OR "locked_balance" > "balance";
--
-- Expect 0. A non-zero result means data must be corrected first; this
-- migration will otherwise fail and roll back.
ALTER TABLE "customer_wallets"
  ADD CONSTRAINT "customer_wallets_balance_non_negative"
  CHECK ("balance" >= 0);

ALTER TABLE "customer_wallets"
  ADD CONSTRAINT "customer_wallets_locked_within_balance"
  CHECK ("locked_balance" >= 0 AND "locked_balance" <= "balance");
