-- FR-022. Referral ride qualification, made idempotent by the database.
--
-- `processRideForReferee` did `qualifyingRides + 1` with no record of WHICH ride
-- caused the increment. Constitution 7.3: delivery is at-least-once and a
-- consumer's safety must come from a database guarantee, not from the relay.
-- There was none, so a redelivered `ride.completed` — an outbox retry, a manual
-- replay — counted the same ride again. On an NTH_RIDE program with a threshold
-- of 5, one ride replayed five times paid out the full referrer and referee
-- reward. The driver variant pays into the settlement wallet.
--
-- One row per (referral, ride). The unique constraint is the guarantee; the
-- counter becomes a projection of it rather than a number anyone increments.
CREATE TABLE "referral_qualifying_rides" (
    "id" UUID NOT NULL,
    "referral_id" UUID NOT NULL,
    "ride_id" UUID NOT NULL,
    "counted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_qualifying_rides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_qualifying_rides_referral_id_ride_id_key"
  ON "referral_qualifying_rides" ("referral_id", "ride_id");

CREATE INDEX "referral_qualifying_rides_referral_id_idx"
  ON "referral_qualifying_rides" ("referral_id");

ALTER TABLE "referral_qualifying_rides"
  ADD CONSTRAINT "referral_qualifying_rides_referral_id_fkey"
  FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referral_qualifying_rides"
  ADD CONSTRAINT "referral_qualifying_rides_ride_id_fkey"
  FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FR-024. A reward that was created but never credited must be findable. The
-- old code left rows PENDING forever with nothing sweeping them.
CREATE INDEX IF NOT EXISTS "referral_rewards_status_created_at_idx"
  ON "referral_rewards" ("status", "created_at");
