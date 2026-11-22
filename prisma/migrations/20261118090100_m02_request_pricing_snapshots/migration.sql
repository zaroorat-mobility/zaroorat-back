-- Phase 1 · Migration M-02 (Request & Fare Snapshot Part)
-- Adds write-once immutable pricing_snapshot on ride_requests and rates_snapshot on ride_fares.

ALTER TABLE "ride_requests"
  ADD COLUMN IF NOT EXISTS "pricing_snapshot" JSONB NULL;

ALTER TABLE "ride_fares"
  ADD COLUMN IF NOT EXISTS "rates_snapshot" JSONB NULL;

-- Rev 5 R5-5: Enforce strict write-once immutability on ride_requests.pricing_snapshot once set.
CREATE OR REPLACE FUNCTION enforce_ride_request_pricing_snapshot_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."pricing_snapshot" IS NOT NULL
     AND NEW."pricing_snapshot" IS DISTINCT FROM OLD."pricing_snapshot" THEN
    RAISE EXCEPTION 'ride_requests.pricing_snapshot is write-once and immutable once populated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ride_requests_pricing_snapshot_immutable" ON "ride_requests";

CREATE TRIGGER "ride_requests_pricing_snapshot_immutable"
  BEFORE UPDATE ON "ride_requests"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ride_request_pricing_snapshot_immutable();
