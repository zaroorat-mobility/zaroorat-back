-- Separation of duties on bank-account verification: everyone who changed the core
-- details after entry, so none of them can verify. Additive; existing rows start empty.
ALTER TABLE "driver_bank_accounts" ADD COLUMN "details_changed_by" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
