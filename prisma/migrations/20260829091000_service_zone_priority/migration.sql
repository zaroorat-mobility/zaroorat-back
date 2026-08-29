-- FR-005. Which zone wins when zones overlap.
--
-- Zone resolution ordered by `created_at ASC LIMIT 1`, so for a point inside
-- both a citywide zone and a nested airport zone it returned the citywide one —
-- whichever polygon the operator happened to draw first. The airport zone's
-- pricing rule was then never probed at all, which defeats zone-based pricing
-- in the nested layout that is its normal configuration.
--
-- `tests/integration/pricing-rule-resolution.test.ts` proves it: the airport
-- rule's base fare of 120 resolved as the citywide 50.
--
-- Defaulted to 0 so this is safe against the previous application version:
-- until an operator sets a priority, every zone ties and `created_at` remains
-- the tie-break, which is exactly the old behaviour.
ALTER TABLE "service_zones" ADD COLUMN "priority" SMALLINT NOT NULL DEFAULT 0;

-- Resolution order is (priority DESC, ST_Area(boundary) ASC, created_at ASC):
-- an explicit operator override first, then the smallest containing polygon, then
-- creation order. Area is the default tie-break because zones nest and the
-- specific one should win without anyone having to know to configure it.
--
-- The index covers the priority/created_at part. The area term is not indexable
-- here and does not need to be: it only ever sorts the handful of zones that
-- already contain the point.
CREATE INDEX IF NOT EXISTS "service_zones_city_id_priority_idx"
  ON "service_zones" ("city_id", "priority" DESC, "created_at" ASC);
