-- FR-034 (G3). "One active rule per key" was enforced only by application code:
-- a `updateMany` that deactivated the incumbent, then a `create`. Two admins
-- saving at once each read no conflict, each deactivated nothing, and each
-- inserted an active rule. `findBestActiveRule` then returned whichever the
-- index happened to order first, so the same journey could be quoted at two
-- different prices depending on nothing the operator could see.
--
-- The constraint is over *time*, not merely over the key. A first attempt used a
-- plain partial unique index on the four key columns, which is what the plan
-- specified — and it forbade the one thing FR-003 exists to support: staging a
-- future-dated rate change beside the card that is live today. "Active" in
-- `pricing_rules` means "not retired", never "in force now"; that is why FR-003
-- had to add an `inForce(now)` predicate in the first place. An exclusion
-- constraint says the real invariant: no two live rules on a key may cover
-- overlapping effective windows.
--
-- Constitution 3.3: neither an exclusion constraint nor a partial predicate can
-- be expressed in the Prisma schema, so both are declared here.
--
-- Split in two because of NULLs. In a GiST exclusion constraint `NULL = NULL` is
-- unknown, so a single constraint would never fire for the most common shape
-- there is — a global rule with no service type and no zone. `service_zone_id`
-- is handled by COALESCE to the nil UUID (immutable; `uuid(7)` never generates
-- it). `service_type` cannot be: it is an enum, and `enum::text` is STABLE, not
-- IMMUTABLE, so it is illegal in an index expression — and collapsing NULL onto
-- a real enum value would conflate "applies to any service type" with "applies
-- to INSTANT only", which are different rules with a defined precedence between
-- them. Two complementary partial constraints keep them distinct.
--
-- Proven against this database, six cases:
--   current rule, open-ended                  -> accepted
--   a second identical open-ended rule        -> rejected  (the race)
--   a successor whose window overlaps it      -> rejected
--   an inactive duplicate                     -> accepted  (version history)
--   the same window with service_type INSTANT -> accepted  (different key)
--   a successor starting when the current ends-> accepted  (FR-003, staged)
--
-- Constitution 3.5 — PRE-FLIGHT, run against the TARGET database before deploy.
-- Existing overlaps make this migration fail, and that is correct: they are
-- FR-034's race having already happened, and a human must choose which wins.
--
--   SELECT a.id, b.id, a.vehicle_type_id, a.city_code
--   FROM pricing_rules a
--   JOIN pricing_rules b
--     ON a.id < b.id
--    AND a.vehicle_type_id = b.vehicle_type_id
--    AND a.city_code = b.city_code
--    AND a.service_type IS NOT DISTINCT FROM b.service_type
--    AND a.service_zone_id IS NOT DISTINCT FROM b.service_zone_id
--    AND tsrange(a.effective_from, a.effective_to)
--     && tsrange(b.effective_from, b.effective_to)
--   WHERE a.is_active AND b.is_active;
--
-- Resolve by deactivating the losers, or by closing the incumbent's
-- `effective_to`. Do not widen the constraint.
--
-- Constitution 3.4: an exclusion constraint cannot be added CONCURRENTLY. Rule
-- volume is small, so the brief ACCESS EXCLUSIVE lock is acceptable; on a large
-- table, build the two GiST indexes concurrently first and add the constraints
-- USING those indexes.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "pricing_rules"
  ADD CONSTRAINT "pricing_rules_one_in_force_typed"
  EXCLUDE USING gist (
    "vehicle_type_id" WITH =,
    "city_code" WITH =,
    "service_type" WITH =,
    (COALESCE("service_zone_id", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tsrange("effective_from", "effective_to") WITH &&
  )
  WHERE ("is_active" AND "service_type" IS NOT NULL);

ALTER TABLE "pricing_rules"
  ADD CONSTRAINT "pricing_rules_one_in_force_untyped"
  EXCLUDE USING gist (
    "vehicle_type_id" WITH =,
    "city_code" WITH =,
    (COALESCE("service_zone_id", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tsrange("effective_from", "effective_to") WITH &&
  )
  WHERE ("is_active" AND "service_type" IS NULL);
