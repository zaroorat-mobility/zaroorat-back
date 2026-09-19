-- H4 Step 2: Database backstop for at most one PENDING_PAYMENT subscription per driver.

CREATE UNIQUE INDEX "driver_subscriptions_one_pending"
  ON "driver_subscriptions" ("driver_id")
  WHERE "status" = 'PENDING_PAYMENT';
