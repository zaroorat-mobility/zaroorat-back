-- Phase 1 · Migration M-07: Fare Rule Lineage & Optimistic Concurrency Support
-- Expand-only and backward-compatible with older application versions.

ALTER TABLE "pricing_rules"
  ADD COLUMN IF NOT EXISTS "rule_family_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "supersedes_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE "pricing_rules"
  ADD CONSTRAINT "pricing_rules_supersedes_id_fkey"
  FOREIGN KEY ("supersedes_id") REFERENCES "pricing_rules"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing rows: group by (vehicle_type_id, city_code, service_type, service_zone_id)
-- ordered by created_at ASC, id ASC. Start a new lineage whenever version = 1 so existing
-- multiple v1 rows remain cleanly distinct and (rule_family_id, version) stays unambiguous.
WITH ordered AS (
  SELECT
    "id",
    "version",
    "created_at",
    "vehicle_type_id",
    "city_code",
    "service_type",
    "service_zone_id",
    SUM(CASE WHEN "version" = 1 THEN 1 ELSE 0 END) OVER (
      PARTITION BY "vehicle_type_id", "city_code", "service_type", "service_zone_id"
      ORDER BY "created_at" ASC, "id" ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS family_seq
  FROM "pricing_rules"
  WHERE "rule_family_id" IS NULL
),
families AS (
  SELECT
    "id",
    FIRST_VALUE("id") OVER (
      PARTITION BY "vehicle_type_id", "city_code", "service_type", "service_zone_id", family_seq
      ORDER BY "created_at" ASC, "id" ASC
    ) AS computed_family_id,
    LAG("id") OVER (
      PARTITION BY "vehicle_type_id", "city_code", "service_type", "service_zone_id", family_seq
      ORDER BY "created_at" ASC, "id" ASC
    ) AS computed_supersedes_id
  FROM ordered
)
UPDATE "pricing_rules" pr
SET
  "rule_family_id" = f.computed_family_id,
  "supersedes_id" = f.computed_supersedes_id,
  "updated_at" = COALESCE(pr."created_at", now())
FROM families f
WHERE pr."id" = f."id";

CREATE INDEX IF NOT EXISTS "pricing_rules_rule_family_id_version_idx"
  ON "pricing_rules" ("rule_family_id", "version");
