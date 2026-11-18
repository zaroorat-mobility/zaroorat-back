-- Phase 4 · Migrations M-03, M-04a, M-04b, M-04c:
-- Independent Commission, Passenger/Commission Tax, and GST Recovery Configurations
-- with per-scope child tables (Rev 5 R5-3) and Multi-Entity / Multi-State Legal Jurisdiction.

CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ============================================================================
-- M-03: Commission Configurations & Per-Scope Enforcement Table
-- ============================================================================
CREATE TABLE "commission_configurations" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"               UUID NOT NULL,
  "version"                 INTEGER NOT NULL CHECK ("version" >= 1),
  "status"                  TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK ("status" IN (
    'DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'PARTIALLY_SUPERSEDED', 'RETIRED', 'REJECTED'
  )),
  "commission_rate_pct"     DECIMAL(5, 2) NOT NULL CHECK ("commission_rate_pct" >= 0 AND "commission_rate_pct" <= 50),
  "is_enabled"              BOOLEAN NOT NULL DEFAULT true,
  "base_rule"               TEXT NOT NULL DEFAULT 'RIDE_SUBTOTAL_BEFORE_DISCOUNT' CHECK ("base_rule" IN (
    'RIDE_SUBTOTAL_BEFORE_DISCOUNT', 'RIDE_SUBTOTAL_AFTER_DISCOUNT', 'PRE_TAX_TOTAL'
  )),
  "include_surge"           BOOLEAN NOT NULL DEFAULT true,
  "include_waiting"         BOOLEAN NOT NULL DEFAULT false,
  "include_booking_fee"     BOOLEAN NOT NULL DEFAULT false,
  "apply_minimum_floor"     BOOLEAN NOT NULL DEFAULT true,
  "round_off_rupee"         BOOLEAN NOT NULL DEFAULT false,
  "apply_to"                TEXT NOT NULL DEFAULT 'NEW_RIDES_ONLY' CHECK ("apply_to" = 'NEW_RIDES_ONLY'),
  "declared_effective_from" TIMESTAMPTZ NOT NULL,
  "declared_effective_to"   TIMESTAMPTZ NULL,
  "reason"                  TEXT NULL,
  "created_by"              UUID NOT NULL,
  "approved_by"             UUID NULL,
  "approved_at"             TIMESTAMPTZ NULL,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "commission_configs_declared_window_check"
    CHECK ("declared_effective_to" IS NULL OR "declared_effective_to" > "declared_effective_from"),
  CONSTRAINT "commission_configs_family_version_key" UNIQUE ("family_id", "version")
);

CREATE INDEX "commission_configurations_status_idx" ON "commission_configurations" ("status");

CREATE TABLE "commission_configuration_scopes" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "config_id"              UUID NOT NULL REFERENCES "commission_configurations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "scope_level"            TEXT NOT NULL CHECK ("scope_level" IN (
    'GLOBAL', 'GLOBAL_VEHICLE', 'CITY', 'CITY_VEHICLE', 'ZONE', 'ZONE_VEHICLE'
  )),
  "city_code"              TEXT NOT NULL DEFAULT '__GLOBAL__',
  "service_zone_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  "vehicle_type_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  "effective_from"         TIMESTAMPTZ NOT NULL,
  "effective_to"           TIMESTAMPTZ NULL,
  "is_enforced"            BOOLEAN NOT NULL DEFAULT false,
  "superseded_by_scope_id" UUID NULL REFERENCES "commission_configuration_scopes"("id") ON DELETE SET NULL,
  "closed_at"              TIMESTAMPTZ NULL,
  "closed_by"              UUID NULL,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "commission_scopes_window_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "commission_scopes_sentinel_check" CHECK (
    ("scope_level" = 'GLOBAL'         AND "city_code" = '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'GLOBAL_VEHICLE' AND "city_code" = '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'CITY'           AND "city_code" <> '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'CITY_VEHICLE'   AND "city_code" <> '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'ZONE'           AND "city_code" <> '__GLOBAL__' AND "service_zone_id" <> '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'ZONE_VEHICLE'   AND "city_code" <> '__GLOBAL__' AND "service_zone_id" <> '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid)
  )
);

ALTER TABLE "commission_configuration_scopes"
  ADD CONSTRAINT "commission_scopes_one_enforced_per_tuple"
  EXCLUDE USING gist (
    "city_code" WITH =,
    "service_zone_id" WITH =,
    "vehicle_type_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  )
  WHERE ("is_enforced" = true);

CREATE INDEX "commission_scopes_config_id_idx" ON "commission_configuration_scopes" ("config_id");
CREATE INDEX "commission_scopes_lookup_idx"
  ON "commission_configuration_scopes" ("is_enforced", "city_code", "service_zone_id", "vehicle_type_id");

-- ============================================================================
-- M-04a: Tax Configurations (Passenger Ride GST & Commission GST) — NO DEFAULT SAC 9964
-- ============================================================================
CREATE TABLE "tax_configurations" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"               UUID NOT NULL,
  "version"                 INTEGER NOT NULL CHECK ("version" >= 1),
  "kind"                    TEXT NOT NULL CHECK ("kind" IN ('PASSENGER_RIDE_GST', 'COMMISSION_GST')),
  "status"                  TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK ("status" IN (
    'DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'PARTIALLY_SUPERSEDED', 'RETIRED', 'REJECTED'
  )),
  "rate_pct"                DECIMAL(5, 2) NOT NULL CHECK ("rate_pct" >= 0 AND "rate_pct" <= 28),
  "is_enabled"              BOOLEAN NOT NULL DEFAULT false,
  "inclusive"               BOOLEAN NOT NULL DEFAULT false,
  "waiting_taxable"         BOOLEAN NULL,
  "sac_code"                TEXT NULL,
  "apply_to"                TEXT NOT NULL DEFAULT 'NEW_RIDES_ONLY' CHECK ("apply_to" = 'NEW_RIDES_ONLY'),
  "declared_effective_from" TIMESTAMPTZ NOT NULL,
  "declared_effective_to"   TIMESTAMPTZ NULL,
  "legal_reference"         TEXT NULL,
  "created_by"              UUID NOT NULL,
  "approved_by"             UUID NULL,
  "approved_at"             TIMESTAMPTZ NULL,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "tax_configs_declared_window_check"
    CHECK ("declared_effective_to" IS NULL OR "declared_effective_to" > "declared_effective_from"),
  CONSTRAINT "tax_configs_approval_classification_check"
    CHECK (
      "status" NOT IN ('SCHEDULED', 'ACTIVE', 'PARTIALLY_SUPERSEDED')
      OR (
        "sac_code" IS NOT NULL
        AND length(trim("sac_code")) >= 4
        AND "legal_reference" IS NOT NULL
        AND length(trim("legal_reference")) >= 3
        AND "waiting_taxable" IS NOT NULL
      )
    ),
  CONSTRAINT "tax_configs_family_version_key" UNIQUE ("family_id", "version")
);

CREATE INDEX "tax_configurations_kind_status_idx" ON "tax_configurations" ("kind", "status");

CREATE TABLE "tax_configuration_scopes" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "config_id"              UUID NOT NULL REFERENCES "tax_configurations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "tax_kind"               TEXT NOT NULL CHECK ("tax_kind" IN ('PASSENGER_RIDE_GST', 'COMMISSION_GST')),
  "scope_level"            TEXT NOT NULL CHECK ("scope_level" IN (
    'GLOBAL', 'GLOBAL_VEHICLE', 'CITY', 'CITY_VEHICLE', 'ZONE', 'ZONE_VEHICLE'
  )),
  "city_code"              TEXT NOT NULL DEFAULT '__GLOBAL__',
  "service_zone_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  "vehicle_type_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  "effective_from"         TIMESTAMPTZ NOT NULL,
  "effective_to"           TIMESTAMPTZ NULL,
  "is_enforced"            BOOLEAN NOT NULL DEFAULT false,
  "superseded_by_scope_id" UUID NULL REFERENCES "tax_configuration_scopes"("id") ON DELETE SET NULL,
  "closed_at"              TIMESTAMPTZ NULL,
  "closed_by"              UUID NULL,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "tax_scopes_window_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "tax_scopes_sentinel_check" CHECK (
    ("scope_level" = 'GLOBAL'         AND "city_code" = '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'GLOBAL_VEHICLE' AND "city_code" = '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'CITY'           AND "city_code" <> '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'CITY_VEHICLE'   AND "city_code" <> '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'ZONE'           AND "city_code" <> '__GLOBAL__' AND "service_zone_id" <> '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'ZONE_VEHICLE'   AND "city_code" <> '__GLOBAL__' AND "service_zone_id" <> '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid)
  )
);

ALTER TABLE "tax_configuration_scopes"
  ADD CONSTRAINT "tax_scopes_one_enforced_per_tuple"
  EXCLUDE USING gist (
    "tax_kind" WITH =,
    "city_code" WITH =,
    "service_zone_id" WITH =,
    "vehicle_type_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  )
  WHERE ("is_enforced" = true);

CREATE INDEX "tax_scopes_config_id_idx" ON "tax_configuration_scopes" ("config_id");
CREATE INDEX "tax_scopes_lookup_idx"
  ON "tax_configuration_scopes" ("is_enforced", "tax_kind", "city_code", "service_zone_id", "vehicle_type_id");

-- ============================================================================
-- M-04b: Driver GST Wallet Recovery Configurations (Independent from Passenger GST Liability)
-- ============================================================================
CREATE TABLE "gst_recovery_configurations" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"               UUID NOT NULL,
  "version"                 INTEGER NOT NULL CHECK ("version" >= 1),
  "status"                  TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK ("status" IN (
    'DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'PARTIALLY_SUPERSEDED', 'RETIRED', 'REJECTED'
  )),
  "recovery_rate_pct"       DECIMAL(5, 2) NOT NULL CHECK ("recovery_rate_pct" >= 0 AND "recovery_rate_pct" <= 28),
  "is_enabled"              BOOLEAN NOT NULL DEFAULT false,
  "base_rule"               TEXT NOT NULL DEFAULT 'PASSENGER_GST_AMOUNT' CHECK ("base_rule" IN (
    'PASSENGER_GST_AMOUNT', 'TAXABLE_VALUE', 'RIDE_SUBTOTAL_BEFORE_DISCOUNT'
  )),
  "round_off_rupee"         BOOLEAN NOT NULL DEFAULT false,
  "apply_to"                TEXT NOT NULL DEFAULT 'NEW_RIDES_ONLY' CHECK ("apply_to" = 'NEW_RIDES_ONLY'),
  "declared_effective_from" TIMESTAMPTZ NOT NULL,
  "declared_effective_to"   TIMESTAMPTZ NULL,
  "legal_reference"         TEXT NULL,
  "created_by"              UUID NOT NULL,
  "approved_by"             UUID NULL,
  "approved_at"             TIMESTAMPTZ NULL,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "gst_recovery_configs_declared_window_check"
    CHECK ("declared_effective_to" IS NULL OR "declared_effective_to" > "declared_effective_from"),
  CONSTRAINT "gst_recovery_configs_family_version_key" UNIQUE ("family_id", "version")
);

CREATE INDEX "gst_recovery_configurations_status_idx" ON "gst_recovery_configurations" ("status");

CREATE TABLE "gst_recovery_configuration_scopes" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "config_id"              UUID NOT NULL REFERENCES "gst_recovery_configurations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "scope_level"            TEXT NOT NULL CHECK ("scope_level" IN (
    'GLOBAL', 'GLOBAL_VEHICLE', 'CITY', 'CITY_VEHICLE', 'ZONE', 'ZONE_VEHICLE'
  )),
  "city_code"              TEXT NOT NULL DEFAULT '__GLOBAL__',
  "service_zone_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  "vehicle_type_id"        UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  "effective_from"         TIMESTAMPTZ NOT NULL,
  "effective_to"           TIMESTAMPTZ NULL,
  "is_enforced"            BOOLEAN NOT NULL DEFAULT false,
  "superseded_by_scope_id" UUID NULL REFERENCES "gst_recovery_configuration_scopes"("id") ON DELETE SET NULL,
  "closed_at"              TIMESTAMPTZ NULL,
  "closed_by"              UUID NULL,
  "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "gst_recovery_scopes_window_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "gst_recovery_scopes_sentinel_check" CHECK (
    ("scope_level" = 'GLOBAL'         AND "city_code" = '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'GLOBAL_VEHICLE' AND "city_code" = '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'CITY'           AND "city_code" <> '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'CITY_VEHICLE'   AND "city_code" <> '__GLOBAL__' AND "service_zone_id" = '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'ZONE'           AND "city_code" <> '__GLOBAL__' AND "service_zone_id" <> '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" = '00000000-0000-0000-0000-000000000000'::uuid) OR
    ("scope_level" = 'ZONE_VEHICLE'   AND "city_code" <> '__GLOBAL__' AND "service_zone_id" <> '00000000-0000-0000-0000-000000000000'::uuid AND "vehicle_type_id" <> '00000000-0000-0000-0000-000000000000'::uuid)
  )
);

ALTER TABLE "gst_recovery_configuration_scopes"
  ADD CONSTRAINT "gst_recovery_scopes_one_enforced_per_tuple"
  EXCLUDE USING gist (
    "city_code" WITH =,
    "service_zone_id" WITH =,
    "vehicle_type_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  )
  WHERE ("is_enforced" = true);

CREATE INDEX "gst_recovery_scopes_config_id_idx" ON "gst_recovery_configuration_scopes" ("config_id");
CREATE INDEX "gst_recovery_scopes_lookup_idx"
  ON "gst_recovery_configuration_scopes" ("is_enforced", "city_code", "service_zone_id", "vehicle_type_id");

-- ============================================================================
-- M-04c: Multi-Entity & Multi-State Legal Jurisdiction (Decoupled from Operational Rates)
-- ============================================================================
CREATE TABLE "legal_entities" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "legal_entity_name"   TEXT NOT NULL,
  "trade_name"          TEXT NULL,
  "pan"                 VARCHAR(10) NOT NULL,
  "head_office_address" TEXT NOT NULL,
  "is_active"           BOOLEAN NOT NULL DEFAULT true,
  "updated_by"          UUID NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "company_gst_registrations" (
  "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "legal_entity_id"      UUID NOT NULL REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "gstin"                VARCHAR(15) NOT NULL UNIQUE,
  "state_code"           VARCHAR(2) NOT NULL,
  "state_name"           TEXT NOT NULL,
  "registration_address" TEXT NOT NULL,
  "effective_from"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "effective_to"         TIMESTAMPTZ NULL,
  "is_active"            BOOLEAN NOT NULL DEFAULT true,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "company_gst_registrations_window_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);

CREATE INDEX "company_gst_registrations_entity_state_idx"
  ON "company_gst_registrations" ("legal_entity_id", "state_code", "is_active");

ALTER TABLE "cities"
  ADD COLUMN IF NOT EXISTS "state_code" VARCHAR(2) NULL,
  ADD COLUMN IF NOT EXISTS "state_name" TEXT NULL;

CREATE TABLE "city_supply_registrations" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "city_code"           TEXT NOT NULL,
  "supply_kind"         TEXT NOT NULL CHECK ("supply_kind" IN ('PASSENGER_RIDE', 'PLATFORM_COMMISSION')),
  "legal_entity_id"     UUID NOT NULL REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "gst_registration_id" UUID NOT NULL REFERENCES "company_gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "effective_from"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "effective_to"        TIMESTAMPTZ NULL,
  "is_active"           BOOLEAN NOT NULL DEFAULT true,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "city_supply_registrations_window_check"
    CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);

ALTER TABLE "city_supply_registrations"
  ADD CONSTRAINT "city_supply_registrations_no_overlap_active"
  EXCLUDE USING gist (
    "city_code" WITH =,
    "supply_kind" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  )
  WHERE ("is_active" = true);

CREATE INDEX "city_supply_registrations_lookup_idx"
  ON "city_supply_registrations" ("city_code", "supply_kind", "is_active");
