-- Rider capability pack: multi-stop, book-for-someone-else, pickup notes,
-- fare boost, scheduled booking, and shareable trip links.
--
-- Purely additive except for the `ride_requests_active_customer_key`
-- predicate, which is narrowed so a scheduled booking (a CREATED request with
-- `scheduled_for` set) does not occupy the rider's single "live search" slot.
-- Without that, a rider holding tomorrow's airport pickup could not book a
-- ride today.

-- ── ride_requests ────────────────────────────────────────────────────────────
ALTER TABLE "ride_requests"
  ADD COLUMN IF NOT EXISTS "passenger_name" TEXT,
  ADD COLUMN IF NOT EXISTS "passenger_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "pickup_notes" TEXT,
  ADD COLUMN IF NOT EXISTS "boost_amount" DECIMAL(10,2);

ALTER TABLE "ride_requests" DROP CONSTRAINT IF EXISTS "ride_requests_passenger_pair_check";
ALTER TABLE "ride_requests"
  ADD CONSTRAINT "ride_requests_passenger_pair_check"
  CHECK (("passenger_name" IS NULL) = ("passenger_phone" IS NULL));

ALTER TABLE "ride_requests" DROP CONSTRAINT IF EXISTS "ride_requests_boost_amount_check";
ALTER TABLE "ride_requests"
  ADD CONSTRAINT "ride_requests_boost_amount_check"
  CHECK ("boost_amount" IS NULL OR "boost_amount" >= 0);

DROP INDEX IF EXISTS "ride_requests_active_customer_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ride_requests_active_customer_key"
  ON "ride_requests" ("customer_id")
  WHERE "status" IN ('CREATED', 'SEARCHING') AND "scheduled_for" IS NULL;

-- ── rides ────────────────────────────────────────────────────────────────────
ALTER TABLE "rides"
  ADD COLUMN IF NOT EXISTS "passenger_name" TEXT,
  ADD COLUMN IF NOT EXISTS "passenger_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "pickup_notes" TEXT;

-- ── ride_request_stops ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ride_request_stops" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "sequence" SMALLINT NOT NULL,
  "lat" DECIMAL(10,7) NOT NULL,
  "lng" DECIMAL(10,7) NOT NULL,
  "location" geography(Point,4326) NOT NULL,
  "address" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ride_request_stops_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ride_request_stops_request_id_sequence_key"
  ON "ride_request_stops" ("request_id", "sequence");

ALTER TABLE "ride_request_stops" DROP CONSTRAINT IF EXISTS "ride_request_stops_request_id_fkey";
ALTER TABLE "ride_request_stops"
  ADD CONSTRAINT "ride_request_stops_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "ride_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ride_share_tokens ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ride_share_tokens" (
  "id" UUID NOT NULL,
  "token" TEXT NOT NULL,
  "ride_id" UUID NOT NULL,
  "created_by" UUID NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ride_share_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ride_share_tokens_token_key" ON "ride_share_tokens" ("token");
CREATE INDEX IF NOT EXISTS "ride_share_tokens_ride_id_idx" ON "ride_share_tokens" ("ride_id");

ALTER TABLE "ride_share_tokens" DROP CONSTRAINT IF EXISTS "ride_share_tokens_ride_id_fkey";
ALTER TABLE "ride_share_tokens"
  ADD CONSTRAINT "ride_share_tokens_ride_id_fkey"
  FOREIGN KEY ("ride_id") REFERENCES "rides"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
