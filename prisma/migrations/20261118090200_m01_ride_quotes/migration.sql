-- Phase 1 · Migration M-01: Persisted Ride Quotes & Quote Lock
-- Expand-only and backward-compatible: ride_requests.quote_id is nullable.

CREATE TABLE "ride_quotes" (
  "id"                     UUID NOT NULL,
  "customer_id"            UUID NULL,
  "pickup_lat"             DECIMAL(10, 7) NOT NULL,
  "pickup_lng"             DECIMAL(10, 7) NOT NULL,
  "drop_lat"               DECIMAL(10, 7) NOT NULL,
  "drop_lng"               DECIMAL(10, 7) NOT NULL,
  "stops"                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  "city_code"              TEXT NOT NULL,
  "promo_code"             TEXT NULL,
  "estimated_distance_km"  DECIMAL(8, 2) NOT NULL,
  "estimated_duration_min" INTEGER NOT NULL,
  "distance_source"        TEXT NOT NULL,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"             TIMESTAMPTZ NOT NULL,
  "consumed_at"            TIMESTAMPTZ NULL,
  CONSTRAINT "ride_quotes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ride_quote_options" (
  "id"                 UUID NOT NULL,
  "quote_id"           UUID NOT NULL,
  "vehicle_type_id"    UUID NOT NULL,
  "pricing_rule_id"    UUID NULL,
  "rule_version"       INTEGER NULL,
  "surge_multiplier"   DECIMAL(4, 2) NOT NULL DEFAULT 1.00,
  "surge_window_id"    UUID NULL,
  "rate_card_snapshot" JSONB NOT NULL,
  "fare_snapshot"      JSONB NOT NULL,
  "total_fare"         DECIMAL(10, 2) NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ride_quote_options_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ride_quote_options_quote_id_fkey"
    FOREIGN KEY ("quote_id") REFERENCES "ride_quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ride_quote_options_vehicle_type_id_fkey"
    FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ride_quote_options_pricing_rule_id_fkey"
    FOREIGN KEY ("pricing_rule_id") REFERENCES "pricing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ride_quote_options_quote_id_vehicle_type_id_key"
    UNIQUE ("quote_id", "vehicle_type_id")
);

ALTER TABLE "ride_requests"
  ADD COLUMN IF NOT EXISTS "quote_id" UUID NULL;

ALTER TABLE "ride_requests"
  ADD CONSTRAINT "ride_requests_quote_id_fkey"
  FOREIGN KEY ("quote_id") REFERENCES "ride_quotes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ride_quotes_customer_id_created_at_idx"
  ON "ride_quotes" ("customer_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "ride_quotes_unconsumed_expires_at_idx"
  ON "ride_quotes" ("expires_at")
  WHERE ("consumed_at" IS NULL);

CREATE INDEX IF NOT EXISTS "ride_requests_quote_id_idx"
  ON "ride_requests" ("quote_id");
