-- A driver pays the platform in exactly one of two ways: SUBSCRIPTION or
-- COMMISSION. Both columns were free TEXT, so any other string could be
-- written and every payment-model branch would silently treat it as "no model".
--
-- NULL stays allowed, deliberately and temporarily:
--   drivers.payment_model       — a driver who has not selected a model yet
--                                 (ride acceptance refuses them).
--   rides.driver_payment_model  — a ride completed before the column existed;
--                                 historical NULL rides must remain readable
--                                 and settle through their legacy branch.
-- NOT NULL is a later, separate step once both are drained.
--
-- Additive and validating: application code has only ever written the two
-- allowed values. Pre-check, expected to return zero rows on both tables:
--   SELECT payment_model, count(*) FROM drivers
--    WHERE payment_model NOT IN ('SUBSCRIPTION', 'COMMISSION') GROUP BY 1;
--   SELECT driver_payment_model, count(*) FROM rides
--    WHERE driver_payment_model NOT IN ('SUBSCRIPTION', 'COMMISSION') GROUP BY 1;

ALTER TABLE "drivers"
  ADD CONSTRAINT "drivers_payment_model_check"
  CHECK ("payment_model" IS NULL OR "payment_model" IN ('SUBSCRIPTION', 'COMMISSION'));

ALTER TABLE "rides"
  ADD CONSTRAINT "rides_driver_payment_model_check"
  CHECK ("driver_payment_model" IS NULL OR "driver_payment_model" IN ('SUBSCRIPTION', 'COMMISSION'));
