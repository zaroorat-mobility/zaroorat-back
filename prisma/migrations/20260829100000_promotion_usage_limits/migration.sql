-- FR-017 / FR-043. Promotion usage limits, enforced by the database.
--
-- Both limits were check-then-act with nothing behind them: `assertPromotionEligible`
-- read `used_count` and counted redemptions at *booking*, `redeem` incremented
-- unconditionally inside the *completion* transaction minutes later, and nothing
-- re-checked in between. A viral promo overshot its cap by however many requests
-- were in flight, and one rider with several rides in flight redeemed a
-- once-per-user promo once per ride.
--
-- Constitution 5.4: uniqueness that must survive a lost lock is a database index.
--
-- `user_use_index` is the redemption's ordinal for that (promotion, user) pair —
-- 1 for the first, 2 for the second. A unique index over the triple makes the
-- per-user cap exact for ANY limit, not just for 1: a concurrent second attempt
-- at slot 1 collides rather than inserting. A plain unique on (promotion, user)
-- could only ever express a limit of exactly 1.

ALTER TABLE "promotion_redemptions" ADD COLUMN "user_use_index" INTEGER;

-- Backfill existing rows in redemption order rather than defaulting them all to
-- 1, which would collide for any user who has already redeemed twice. Verified
-- as 0 rows in the target database before deploy, but written to be correct
-- regardless (constitution 3.5 — never assume clean).
UPDATE "promotion_redemptions" pr
SET "user_use_index" = s.rn
FROM (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "promotion_id", "user_id"
           ORDER BY "redeemed_at" ASC, "id" ASC
         ) AS rn
  FROM "promotion_redemptions"
) s
WHERE pr."id" = s."id";

ALTER TABLE "promotion_redemptions" ALTER COLUMN "user_use_index" SET NOT NULL;
ALTER TABLE "promotion_redemptions" ALTER COLUMN "user_use_index" SET DEFAULT 1;

CREATE UNIQUE INDEX "promotion_redemptions_promotion_user_use_key"
  ON "promotion_redemptions" ("promotion_id", "user_id", "user_use_index");

-- The per-user count is read on every eligibility check; the two single-column
-- indexes that existed could not serve it.
CREATE INDEX IF NOT EXISTS "promotion_redemptions_promotion_user_idx"
  ON "promotion_redemptions" ("promotion_id", "user_id");

-- FR-043. `usage_limit_per_user = 0` read as "nobody may ever use this", because
-- `userUses >= 0` is true for a user with no redemptions at all. Nothing in the
-- admin API could produce it (the zod schema enforces min(1)), but the column
-- allowed it and the natural reading of 0 is "no limit".
--
-- Made nullable so NULL means unlimited, matching `usage_limit_total`'s existing
-- convention rather than inventing a second one, and 0 is forbidden outright.
ALTER TABLE "promotions" ALTER COLUMN "usage_limit_per_user" DROP NOT NULL;
ALTER TABLE "promotions" ALTER COLUMN "usage_limit_per_user" DROP DEFAULT;
ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_usage_limit_per_user_positive"
  CHECK ("usage_limit_per_user" IS NULL OR "usage_limit_per_user" >= 1);
