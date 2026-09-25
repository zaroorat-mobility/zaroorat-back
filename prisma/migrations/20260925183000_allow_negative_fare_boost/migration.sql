-- Fare adjust allows −₹10 below quote; previous check required boost_amount >= 0.
ALTER TABLE "ride_requests"
  DROP CONSTRAINT IF EXISTS "ride_requests_boost_amount_check";

ALTER TABLE "ride_requests"
  ADD CONSTRAINT "ride_requests_boost_amount_check"
  CHECK ("boost_amount" IN (-10, 0, 20, 30, 40, 50, 60));
