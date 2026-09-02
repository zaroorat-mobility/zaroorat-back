-- BD-8 / FR-046. Contract half of the expand/contract rename.
--
-- Phase 4 added `referral_programs.qualification_window_days` and backfilled it
-- from `reward_expiry_days`, and stopped writing `referral_rewards.expires_at`.
-- Run one release later.
--
-- Pre-flight (PRODUCTION):
--   SELECT count(*) FROM referral_programs WHERE qualification_window_days IS NULL;

ALTER TABLE "referral_programs" DROP COLUMN IF EXISTS "reward_expiry_days";
ALTER TABLE "referral_rewards" DROP COLUMN IF EXISTS "expires_at";
