-- FR-046 / BD-8 A, expand phase.
--
-- `reward_expiry_days` is named for a behaviour it does not have. It is applied
-- to `Referral.expires_at` — the deadline by which the referee must qualify —
-- while `referral_rewards.expires_at`, the column that would actually expire a
-- granted reward, is written by nothing. An operator setting "rewards expire
-- after 30 days" was configuring "the referee has 30 days to take their first
-- ride", which is a different product decision.
--
-- Expand/contract, because a column rename is not backward compatible and
-- migrate-then-deploy leaves the previous application version running
-- (constitution 16.2):
--   * this migration ADDS `qualification_window_days` and backfills it;
--   * the application reads the new column and writes both;
--   * a follow-up release drops `reward_expiry_days` and
--     `referral_rewards.expires_at`, once no running version reads either.
--
-- The drop is recorded in plan.md under "Deferred drops" so it cannot become
-- permanent debt by being forgotten.
ALTER TABLE "referral_programs" ADD COLUMN "qualification_window_days" INTEGER;

UPDATE "referral_programs"
SET "qualification_window_days" = "reward_expiry_days"
WHERE "reward_expiry_days" IS NOT NULL;
