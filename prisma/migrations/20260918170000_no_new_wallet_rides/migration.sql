-- D1 / C1 — Database backstop: new ride requests and rides may only use CASH, UPI, or CARD.
--
-- Rationale for trigger vs CHECK constraint:
-- PostgreSQL CHECK constraints (even when created with NOT VALID) are evaluated on ANY
-- UPDATE of an existing row. If a historical row has payment_method = 'WALLET' and a
-- service later updates `status` or `payment_status` without changing payment_method,
-- a CHECK constraint evaluates 'WALLET' IN ('CASH', 'UPI', 'CARD') -> FALSE and fails.
--
-- BEFORE INSERT OR UPDATE triggers selectively enforce:
--   1. INSERT of payment_method = 'WALLET' -> REJECT
--   2. UPDATE changing non-WALLET (or NULL) -> 'WALLET' -> REJECT
--   3. UPDATE on existing historical WALLET row (OLD.payment_method = 'WALLET') preserving WALLET -> ALLOW
--   4. UPDATE on historical WALLET row modifying status / payment_status / updated_at -> ALLOW

-- Clean up any legacy CHECK constraint if previously applied
ALTER TABLE "ride_requests" DROP CONSTRAINT IF EXISTS "ride_requests_payment_method_new_check";
ALTER TABLE "rides"         DROP CONSTRAINT IF EXISTS "rides_payment_method_new_check";

-- -----------------------------------------------------------------------------
-- 1. Trigger function & trigger for ride_requests
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_no_new_wallet_ride_request()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF (NEW.payment_method = 'WALLET') THEN
      RAISE EXCEPTION 'New ride requests may not use WALLET. Allowed methods: CASH, UPI, CARD.'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'ride_requests_payment_method_new_check';
    END IF;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF (NEW.payment_method = 'WALLET' AND (OLD.payment_method IS NULL OR OLD.payment_method != 'WALLET')) THEN
      RAISE EXCEPTION 'Cannot update payment_method to WALLET. Allowed methods: CASH, UPI, CARD.'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'ride_requests_payment_method_new_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_check_no_new_wallet_ride_request" ON "ride_requests";
CREATE TRIGGER "trg_check_no_new_wallet_ride_request"
  BEFORE INSERT OR UPDATE OF "payment_method"
  ON "ride_requests"
  FOR EACH ROW
  EXECUTE FUNCTION check_no_new_wallet_ride_request();

-- -----------------------------------------------------------------------------
-- 2. Trigger function & trigger for rides
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_no_new_wallet_ride()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF (NEW.payment_method = 'WALLET') THEN
      RAISE EXCEPTION 'New rides may not use WALLET. Allowed methods: CASH, UPI, CARD.'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'rides_payment_method_new_check';
    END IF;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF (NEW.payment_method = 'WALLET' AND OLD.payment_method != 'WALLET') THEN
      RAISE EXCEPTION 'Cannot update payment_method to WALLET. Allowed methods: CASH, UPI, CARD.'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'rides_payment_method_new_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_check_no_new_wallet_ride" ON "rides";
CREATE TRIGGER "trg_check_no_new_wallet_ride"
  BEFORE INSERT OR UPDATE OF "payment_method"
  ON "rides"
  FOR EACH ROW
  EXECUTE FUNCTION check_no_new_wallet_ride();
