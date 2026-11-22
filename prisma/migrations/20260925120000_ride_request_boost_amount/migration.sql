-- Customer fare bump while a request is still searching. Drivers see
-- quoted_fare + boost_amount; boosting also re-opens passed offers.
ALTER TABLE "ride_requests"
  ADD COLUMN IF NOT EXISTS "boost_amount" DECIMAL(10, 2) NOT NULL DEFAULT 0;
