-- Phase 3 · Migration M-06: Cancellation Policy Versioning & Ride Cancellation Snapshots
-- Expand-only and backward-compatible with older application versions.

CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- 1. Expand cancellation_policies with versioning, caps, fee base, driver compensation, and effective windows
ALTER TABLE "cancellation_policies"
  ADD COLUMN IF NOT EXISTS "rule_name"                  TEXT NULL,
  ADD COLUMN IF NOT EXISTS "family_id"                  UUID NULL,
  ADD COLUMN IF NOT EXISTS "version"                    INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "supersedes_id"              UUID NULL,
  ADD COLUMN IF NOT EXISTS "max_fee"                    DECIMAL(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS "fee_base"                   TEXT NOT NULL DEFAULT 'QUOTED_FARE',
  ADD COLUMN IF NOT EXISTS "driver_compensation_type"   TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "driver_compensation_amount" DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "driver_penalty_amount"      DECIMAL(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS "effective_from"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "effective_to"               TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "created_by"                 UUID NULL,
  ADD COLUMN IF NOT EXISTS "updated_at"                 TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill existing policies cleanly so every legacy row has a valid family_id and effective_from
UPDATE "cancellation_policies"
SET
  "family_id" = "id",
  "effective_from" = COALESCE("created_at", now()),
  "updated_at" = COALESCE("created_at", now())
WHERE "family_id" IS NULL;

ALTER TABLE "cancellation_policies"
  ALTER COLUMN "family_id" SET NOT NULL;

-- Foreign keys
ALTER TABLE "cancellation_policies"
  ADD CONSTRAINT "cancellation_policies_supersedes_id_fkey"
  FOREIGN KEY ("supersedes_id") REFERENCES "cancellation_policies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Use NOT VALID so legacy orphaned vehicle_type_id rows never block rollout while
-- every new insert/update is strictly validated against vehicle_types(id).
ALTER TABLE "cancellation_policies"
  ADD CONSTRAINT "cancellation_policies_vehicle_type_id_fkey"
  FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

-- Domain CHECK constraints
ALTER TABLE "cancellation_policies"
  ADD CONSTRAINT "cancellation_policies_effective_window_check"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  ADD CONSTRAINT "cancellation_policies_fee_base_check"
  CHECK ("fee_base" IN ('QUOTED_FARE', 'BASE_FARE', 'MINIMUM_FARE')),
  ADD CONSTRAINT "cancellation_policies_driver_comp_type_check"
  CHECK ("driver_compensation_type" IN ('NONE', 'FLAT', 'PERCENT_OF_FEE')),
  ADD CONSTRAINT "cancellation_policies_non_negative_check"
  CHECK (
    "fee_amount" >= 0
    AND "free_cancel_window_sec" >= 0
    AND ("max_fee" IS NULL OR "max_fee" >= 0)
    AND "driver_compensation_amount" >= 0
    AND ("driver_penalty_amount" IS NULL OR "driver_penalty_amount" >= 0)
  );

-- Concurrency-safe GiST exclusion constraint: at most one active policy per
-- (cancelled_by, min_status, city_code, vehicle_type_id) at any instant in time.
ALTER TABLE "cancellation_policies"
  ADD CONSTRAINT "cancellation_policies_no_overlap_active"
  EXCLUDE USING gist (
    "cancelled_by" WITH =,
    COALESCE("min_status", '__ANY__') WITH =,
    COALESCE("city_code", '__GLOBAL__') WITH =,
    COALESCE("vehicle_type_id", '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  )
  WHERE ("is_active" = true);

CREATE INDEX IF NOT EXISTS "cancellation_policies_family_id_version_idx"
  ON "cancellation_policies" ("family_id", "version");

CREATE INDEX IF NOT EXISTS "cancellation_policies_cancelled_by_min_status_is_active_idx"
  ON "cancellation_policies" ("cancelled_by", "min_status", "is_active");

CREATE INDEX IF NOT EXISTS "cancellation_policies_supersedes_id_idx"
  ON "cancellation_policies" ("supersedes_id");

-- 2. Expand ride_cancellations with policy lineage, driver compensation, fee_status & immutable snapshot
ALTER TABLE "ride_cancellations"
  ADD COLUMN IF NOT EXISTS "driver_compensation" DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fee_status"          TEXT NOT NULL DEFAULT 'WAIVED',
  ADD COLUMN IF NOT EXISTS "policy_id"           UUID NULL,
  ADD COLUMN IF NOT EXISTS "policy_version"      INTEGER NULL,
  ADD COLUMN IF NOT EXISTS "policy_snapshot"     JSONB NULL;

-- Backfill fee_status accurately for historical rows
UPDATE "ride_cancellations"
SET "fee_status" = CASE
  WHEN "cancellation_fee" > 0 AND "fee_charged" = true THEN 'COLLECTED'
  WHEN "cancellation_fee" > 0 THEN 'ASSESSED'
  ELSE 'WAIVED'
END;

ALTER TABLE "ride_cancellations"
  ADD CONSTRAINT "ride_cancellations_policy_id_fkey"
  FOREIGN KEY ("policy_id") REFERENCES "cancellation_policies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ride_cancellations"
  ADD CONSTRAINT "ride_cancellations_fee_status_check"
  CHECK ("fee_status" IN ('WAIVED', 'ASSESSED', 'COLLECTED', 'DISPUTED', 'REFUNDED')),
  ADD CONSTRAINT "ride_cancellations_non_negative_check"
  CHECK ("cancellation_fee" >= 0 AND "driver_compensation" >= 0);

CREATE INDEX IF NOT EXISTS "ride_cancellations_policy_id_idx"
  ON "ride_cancellations" ("policy_id");

CREATE INDEX IF NOT EXISTS "ride_cancellations_fee_status_idx"
  ON "ride_cancellations" ("fee_status");

-- Enforce write-once immutability on ride_cancellations.policy_snapshot once populated
CREATE OR REPLACE FUNCTION enforce_ride_cancellation_policy_snapshot_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."policy_snapshot" IS NOT NULL
     AND NEW."policy_snapshot" IS DISTINCT FROM OLD."policy_snapshot" THEN
    RAISE EXCEPTION 'ride_cancellations.policy_snapshot is write-once and immutable once populated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ride_cancellations_policy_snapshot_immutable" ON "ride_cancellations";

CREATE TRIGGER "ride_cancellations_policy_snapshot_immutable"
  BEFORE UPDATE ON "ride_cancellations"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ride_cancellation_policy_snapshot_immutable();
