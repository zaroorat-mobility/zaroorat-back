-- Phase 6 · Migration M-09: Fiscal Documents, Gapless Document Series & Persisted Compliance Templates
-- Strict Rev 5 guarantees:
--  1. Gapless document numbering per (gst_registration_id, document_type, financial_year) via row lock (`FOR UPDATE`).
--  2. Zero default SAC '9964' — `sac_code` is copied verbatim from immutable ride snapshots (NULL when not applicable).
--  3. Issued `fiscal_documents` are write-once immutable (only `ISSUED -> VOIDED` status transition permitted; DELETE & TRUNCATE blocked).
--  4. Persisted CR-03 `compliance_templates` with server-side validation, preview approval, and at most one active template per document type.

CREATE TABLE "document_series" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "gst_registration_id" UUID NOT NULL REFERENCES "company_gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "document_type"       TEXT NOT NULL CHECK ("document_type" IN (
    'PASSENGER_TAX_INVOICE',
    'COMMISSION_TAX_INVOICE',
    'DRIVER_SETTLEMENT_STATEMENT',
    'CREDIT_NOTE',
    'SUBSCRIPTION_INVOICE'
  )),
  "financial_year"      TEXT NOT NULL CHECK ("financial_year" ~ '^\d{4}-\d{2}$'),
  "prefix"              TEXT NOT NULL CHECK (length(trim("prefix")) BETWEEN 2 AND 24),
  "last_sequence"       BIGINT NOT NULL DEFAULT 0 CHECK ("last_sequence" >= 0),
  "is_active"           BOOLEAN NOT NULL DEFAULT true,
  "created_by"          UUID NOT NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_series_reg_type_fy_key" UNIQUE ("gst_registration_id", "document_type", "financial_year"),
  CONSTRAINT "document_series_prefix_fy_key"   UNIQUE ("prefix", "financial_year")
);

CREATE INDEX "document_series_active_idx"
  ON "document_series" ("gst_registration_id", "document_type", "is_active");

CREATE TABLE "compliance_templates" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"           UUID NOT NULL,
  "version"             INTEGER NOT NULL CHECK ("version" >= 1),
  "document_type"       TEXT NOT NULL CHECK ("document_type" IN (
    'PASSENGER_TAX_INVOICE',
    'COMMISSION_TAX_INVOICE',
    'DRIVER_SETTLEMENT_STATEMENT',
    'CREDIT_NOTE',
    'SUBSCRIPTION_INVOICE'
  )),
  "name"                TEXT NOT NULL CHECK (length(trim("name")) BETWEEN 1 AND 120),
  "file_name"           TEXT NOT NULL CHECK (length(trim("file_name")) BETWEEN 1 AND 160),
  "mime_type"           TEXT NOT NULL DEFAULT 'text/html',
  "content"             TEXT NOT NULL,
  "version_note"        TEXT NULL,
  "effective_from"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "preview_approved"    BOOLEAN NOT NULL DEFAULT false,
  "preview_approved_by" UUID NULL,
  "preview_approved_at" TIMESTAMPTZ NULL,
  "is_active"           BOOLEAN NOT NULL DEFAULT false,
  "created_by"          UUID NOT NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "compliance_templates_family_version_key" UNIQUE ("family_id", "version"),
  CONSTRAINT "compliance_templates_active_requires_preview_approval"
    CHECK (NOT "is_active" OR "preview_approved" = true)
);

-- At most one active compliance template per document type
CREATE UNIQUE INDEX "compliance_templates_one_active_per_type"
  ON "compliance_templates" ("document_type")
  WHERE "is_active" = true;

CREATE INDEX "compliance_templates_type_created_idx"
  ON "compliance_templates" ("document_type", "created_at" DESC);

CREATE TABLE "fiscal_documents" (
  "id"                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_number"            TEXT NOT NULL UNIQUE,
  "series_id"                  UUID NOT NULL REFERENCES "document_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "sequence_number"            BIGINT NOT NULL CHECK ("sequence_number" >= 1),
  "document_type"              TEXT NOT NULL CHECK ("document_type" IN (
    'PASSENGER_TAX_INVOICE',
    'COMMISSION_TAX_INVOICE',
    'DRIVER_SETTLEMENT_STATEMENT',
    'CREDIT_NOTE',
    'SUBSCRIPTION_INVOICE'
  )),
  "status"                     TEXT NOT NULL DEFAULT 'ISSUED' CHECK ("status" IN ('ISSUED', 'VOIDED')),
  "ride_id"                    UUID NULL REFERENCES "rides"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recipient_user_id"          UUID NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "recipient_type"             TEXT NOT NULL CHECK ("recipient_type" IN ('RIDER', 'DRIVER')),
  "recipient_name"             TEXT NOT NULL,
  "legal_entity_id"            UUID NOT NULL REFERENCES "legal_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "gst_registration_id"        UUID NOT NULL REFERENCES "company_gst_registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "supplier_legal_name"        TEXT NOT NULL,
  "supplier_gstin"             VARCHAR(15) NOT NULL,
  "supplier_state_code"        VARCHAR(2) NOT NULL,
  "place_of_supply_state_code" VARCHAR(2) NOT NULL,
  "is_inter_state"             BOOLEAN NOT NULL DEFAULT false,
  -- Deliberately NULLABLE with NO default '9964': must be copied from CA-approved ride snapshot.
  "sac_code"                   TEXT NULL,
  "currency"                   VARCHAR(3) NOT NULL DEFAULT 'INR',
  "taxable_value"              DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("taxable_value" >= 0),
  "non_taxable_value"          DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("non_taxable_value" >= 0),
  "cgst_rate_pct"              DECIMAL(5, 2) NOT NULL DEFAULT 0 CHECK ("cgst_rate_pct" >= 0),
  "sgst_rate_pct"              DECIMAL(5, 2) NOT NULL DEFAULT 0 CHECK ("sgst_rate_pct" >= 0),
  "igst_rate_pct"              DECIMAL(5, 2) NOT NULL DEFAULT 0 CHECK ("igst_rate_pct" >= 0),
  "cgst_amount"                DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("cgst_amount" >= 0),
  "sgst_amount"                DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("sgst_amount" >= 0),
  "igst_amount"                DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("igst_amount" >= 0),
  "total_tax_amount"           DECIMAL(12, 2) NOT NULL DEFAULT 0 CHECK ("total_tax_amount" >= 0),
  "total_amount"               DECIMAL(12, 2) NOT NULL CHECK ("total_amount" >= 0),
  "line_items_json"            JSONB NOT NULL,
  "snapshot_refs_json"         JSONB NOT NULL,
  "template_id"                UUID NULL REFERENCES "compliance_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "content_sha256"             VARCHAR(64) NOT NULL,
  "void_reason"                TEXT NULL,
  "voided_by"                  UUID NULL,
  "voided_at"                  TIMESTAMPTZ NULL,
  "issued_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at"                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "fiscal_documents_series_sequence_key" UNIQUE ("series_id", "sequence_number"),
  CONSTRAINT "fiscal_documents_tax_sum_check"
    CHECK ("total_tax_amount" = "cgst_amount" + "sgst_amount" + "igst_amount")
);

-- At-least-once outbox idempotency: at most one document of each type per ride
CREATE UNIQUE INDEX "fiscal_documents_one_per_ride_type"
  ON "fiscal_documents" ("ride_id", "document_type")
  WHERE "ride_id" IS NOT NULL;

CREATE INDEX "fiscal_documents_issued_at_idx" ON "fiscal_documents" ("issued_at" DESC);
CREATE INDEX "fiscal_documents_recipient_idx" ON "fiscal_documents" ("recipient_type", "recipient_user_id");
CREATE INDEX "fiscal_documents_ride_idx"      ON "fiscal_documents" ("ride_id");

-- Immutability guard: fiscal documents cannot be edited or deleted once issued
-- (only status transition ISSUED -> VOIDED with void metadata is allowed).
CREATE OR REPLACE FUNCTION enforce_fiscal_document_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'fiscal_documents are immutable and cannot be deleted';
  END IF;

  IF OLD."status" = 'VOIDED' THEN
    RAISE EXCEPTION 'VOIDED fiscal_document cannot be modified';
  END IF;

  IF NEW."status" <> 'VOIDED'
     OR NEW."document_number" IS DISTINCT FROM OLD."document_number"
     OR NEW."series_id" IS DISTINCT FROM OLD."series_id"
     OR NEW."sequence_number" IS DISTINCT FROM OLD."sequence_number"
     OR NEW."document_type" IS DISTINCT FROM OLD."document_type"
     OR NEW."ride_id" IS DISTINCT FROM OLD."ride_id"
     OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
     OR NEW."recipient_type" IS DISTINCT FROM OLD."recipient_type"
     OR NEW."recipient_name" IS DISTINCT FROM OLD."recipient_name"
     OR NEW."legal_entity_id" IS DISTINCT FROM OLD."legal_entity_id"
     OR NEW."gst_registration_id" IS DISTINCT FROM OLD."gst_registration_id"
     OR NEW."supplier_legal_name" IS DISTINCT FROM OLD."supplier_legal_name"
     OR NEW."supplier_gstin" IS DISTINCT FROM OLD."supplier_gstin"
     OR NEW."supplier_state_code" IS DISTINCT FROM OLD."supplier_state_code"
     OR NEW."place_of_supply_state_code" IS DISTINCT FROM OLD."place_of_supply_state_code"
     OR NEW."is_inter_state" IS DISTINCT FROM OLD."is_inter_state"
     OR NEW."sac_code" IS DISTINCT FROM OLD."sac_code"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."taxable_value" IS DISTINCT FROM OLD."taxable_value"
     OR NEW."non_taxable_value" IS DISTINCT FROM OLD."non_taxable_value"
     OR NEW."cgst_rate_pct" IS DISTINCT FROM OLD."cgst_rate_pct"
     OR NEW."sgst_rate_pct" IS DISTINCT FROM OLD."sgst_rate_pct"
     OR NEW."igst_rate_pct" IS DISTINCT FROM OLD."igst_rate_pct"
     OR NEW."cgst_amount" IS DISTINCT FROM OLD."cgst_amount"
     OR NEW."sgst_amount" IS DISTINCT FROM OLD."sgst_amount"
     OR NEW."igst_amount" IS DISTINCT FROM OLD."igst_amount"
     OR NEW."total_tax_amount" IS DISTINCT FROM OLD."total_tax_amount"
     OR NEW."total_amount" IS DISTINCT FROM OLD."total_amount"
     OR NEW."line_items_json" IS DISTINCT FROM OLD."line_items_json"
     OR NEW."snapshot_refs_json" IS DISTINCT FROM OLD."snapshot_refs_json"
     OR NEW."template_id" IS DISTINCT FROM OLD."template_id"
     OR NEW."content_sha256" IS DISTINCT FROM OLD."content_sha256"
     OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
  THEN
    RAISE EXCEPTION 'fiscal_documents are immutable once issued (only ISSUED -> VOIDED allowed)';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "fiscal_documents_immutable" ON "fiscal_documents";
CREATE TRIGGER "fiscal_documents_immutable"
  BEFORE UPDATE OR DELETE ON "fiscal_documents"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_fiscal_document_immutable();

DROP TRIGGER IF EXISTS "fiscal_documents_no_truncate" ON "fiscal_documents";
CREATE TRIGGER "fiscal_documents_no_truncate"
  BEFORE TRUNCATE ON "fiscal_documents"
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_financial_truncate();
