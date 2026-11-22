-- Phase 4 · Migration M-02 (Ride Financial Snapshots & Append-Only Pricing Revisions)
-- Rev 5 R5-2 & R5-5: Write-once accept-time snapshots on `rides` + append-only `ride_pricing_revisions`.

-- 1. Expand rides with accept-time grandfathered subscription link & write-once financial snapshots
ALTER TABLE "rides"
  ADD COLUMN IF NOT EXISTS "driver_subscription_id"  UUID NULL,
  ADD COLUMN IF NOT EXISTS "commission_snapshot"     JSONB NULL,
  ADD COLUMN IF NOT EXISTS "passenger_gst_snapshot"  JSONB NULL,
  ADD COLUMN IF NOT EXISTS "gst_recovery_snapshot"   JSONB NULL;

CREATE INDEX IF NOT EXISTS "rides_driver_subscription_id_idx"
  ON "rides" ("driver_subscription_id")
  WHERE "driver_subscription_id" IS NOT NULL;

-- Enforce strict write-once immutability on accept-time financial snapshots once populated.
CREATE OR REPLACE FUNCTION enforce_ride_financial_snapshots_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."commission_snapshot" IS NOT NULL
     AND NEW."commission_snapshot" IS DISTINCT FROM OLD."commission_snapshot" THEN
    RAISE EXCEPTION 'rides.commission_snapshot is write-once and immutable once populated';
  END IF;
  IF OLD."passenger_gst_snapshot" IS NOT NULL
     AND NEW."passenger_gst_snapshot" IS DISTINCT FROM OLD."passenger_gst_snapshot" THEN
    RAISE EXCEPTION 'rides.passenger_gst_snapshot is write-once and immutable once populated';
  END IF;
  IF OLD."gst_recovery_snapshot" IS NOT NULL
     AND NEW."gst_recovery_snapshot" IS DISTINCT FROM OLD."gst_recovery_snapshot" THEN
    RAISE EXCEPTION 'rides.gst_recovery_snapshot is write-once and immutable once populated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "rides_financial_snapshots_immutable" ON "rides";

CREATE TRIGGER "rides_financial_snapshots_immutable"
  BEFORE UPDATE ON "rides"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ride_financial_snapshots_immutable();

-- 2. Append-only ride_pricing_revisions (post-accept destination/route/completion revisions)
CREATE TABLE "ride_pricing_revisions" (
  "id"                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ride_id"                   UUID NOT NULL REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "revision_number"           INTEGER NOT NULL CHECK ("revision_number" >= 1),
  "reason"                    TEXT NOT NULL CHECK ("reason" IN (
    'DESTINATION_CHANGE', 'STOP_ADDED', 'ROUTE_CHANGE', 'COMPLETION_FINALIZATION'
  )),
  "original_pricing_rule_id"  UUID NULL,
  "original_commission_cfg_id" UUID NULL,
  "original_tax_cfg_id"       UUID NULL,
  "original_recovery_cfg_id"  UUID NULL,
  "calculation_details_json"  JSONB NOT NULL,
  "previous_reserved_amount"  DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("previous_reserved_amount" >= 0),
  "new_reserved_amount"       DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("new_reserved_amount" >= 0),
  "delta_reserved_amount"     DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "wallet_reservation_id"     UUID NULL,
  "customer_confirmed_at"     TIMESTAMPTZ NULL,
  "driver_confirmed_at"       TIMESTAMPTZ NULL,
  "confirmed_by_actor_id"     UUID NULL,
  "created_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ride_pricing_revisions_ride_rev_key" UNIQUE ("ride_id", "revision_number")
);

CREATE INDEX "ride_pricing_revisions_ride_id_created_at_idx"
  ON "ride_pricing_revisions" ("ride_id", "created_at");

-- Strictly append-only: block UPDATE and DELETE; gate TRUNCATE via reject_financial_truncate()
CREATE OR REPLACE FUNCTION reject_ride_pricing_revision_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ride_pricing_revisions is strictly append-only: % refused', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ride_pricing_revisions_no_mutation" ON "ride_pricing_revisions";
CREATE TRIGGER "ride_pricing_revisions_no_mutation"
  BEFORE UPDATE OR DELETE ON "ride_pricing_revisions"
  FOR EACH ROW
  EXECUTE FUNCTION reject_ride_pricing_revision_mutation();

DROP TRIGGER IF EXISTS "ride_pricing_revisions_no_truncate" ON "ride_pricing_revisions";
CREATE TRIGGER "ride_pricing_revisions_no_truncate"
  BEFORE TRUNCATE ON "ride_pricing_revisions"
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_financial_truncate();
