-- FR-009 (B5). The platform fee could not be switched off, and a rule that set
-- it to zero silently inherited the environment default instead.
--
-- `price()` read `platformFeePct > 0 ? taxable * pct : platformFeeFlat`, and
-- `rateCardFor` copied `platformFeeFlat` from `pricingConfig.defaultRateCard`
-- unconditionally — even when a rule had matched. So an operator who set
-- `platformFeePct = 0`, meaning "this city charges no platform fee", got the
-- env's flat RIDE_PLATFORM_FEE (15 by default) on every ride instead. The one
-- setting that turns the fee off was the one that could not be expressed.
--
-- A nullable column is what distinguishes "this rule sets a flat fee" from
-- "this rule says nothing, fall back to the environment".
--
-- Safe against the previous application version: nullable and additive. The old
-- code never selects it and keeps reading the env default; the new code prefers
-- the column when the rule carries one.

ALTER TABLE "pricing_rules"
  ADD COLUMN IF NOT EXISTS "platform_fee_flat" DECIMAL(10,2);
