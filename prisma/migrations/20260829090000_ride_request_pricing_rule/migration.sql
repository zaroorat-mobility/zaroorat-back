-- FR-002. The rule that priced the quote, recorded on the request that carried it.
--
-- Completion used to re-resolve a rate card from scratch, and did it without a
-- city or a pickup point, so it always landed on the GLOBAL default card while
-- the quote had used a city- or zone-scoped rule. The two prices disagreed on
-- every ride in a city that had a rule of its own.
--
-- Nullable and ON DELETE SET NULL on purpose:
--   * nullable, because the previous application version does not write it and
--     migrate-then-deploy leaves that version running during the rollout
--     (constitution 16.2); rows it creates carry NULL and completion falls back
--     to live resolution.
--   * SET NULL rather than RESTRICT, because a fare rule must stay deletable;
--     `AdminFareService` supersedes rules by inserting new versions, so the
--     referenced row is normally retained anyway.
ALTER TABLE "ride_requests" ADD COLUMN "pricing_rule_id" UUID;

ALTER TABLE "ride_requests"
  ADD CONSTRAINT "ride_requests_pricing_rule_id_fkey"
  FOREIGN KEY ("pricing_rule_id") REFERENCES "pricing_rules"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ride_requests_pricing_rule_id_idx"
  ON "ride_requests" ("pricing_rule_id");
