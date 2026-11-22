-- Allow direct admin activation of tax_configurations (e.g. PASSENGER_RIDE_GST)
-- without requiring a pre-registered SAC code at creation time.
ALTER TABLE "tax_configurations"
  DROP CONSTRAINT IF EXISTS "tax_configs_approval_classification_check";
