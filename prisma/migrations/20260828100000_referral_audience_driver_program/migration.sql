-- Referral program audience (Rider vs Driver recruitment) — idempotent steps for partial applies

DO $$ BEGIN
  CREATE TYPE "ReferralProgramAudience" AS ENUM ('RIDER', 'DRIVER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReferralQualifyingEvent" AS ENUM (
    'SIGNUP',
    'FIRST_RIDE',
    'NTH_RIDE',
    'DRIVER_APPROVED',
    'DRIVER_FIRST_RIDE',
    'DRIVER_NTH_RIDE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReferralRewardWallet" AS ENUM ('CUSTOMER', 'DRIVER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "ReferralRewardBeneficiary" ADD VALUE 'MILESTONE';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "referral_programs"
  ADD COLUMN IF NOT EXISTS "audience" "ReferralProgramAudience" NOT NULL DEFAULT 'RIDER',
  ADD COLUMN IF NOT EXISTS "reward_wallet" "ReferralRewardWallet" NOT NULL DEFAULT 'CUSTOMER';

DO $$ BEGIN
  ALTER TABLE "referral_programs"
    ALTER COLUMN "qualifying_event" DROP DEFAULT;
EXCEPTION
  WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "referral_programs"
    ALTER COLUMN "qualifying_event" TYPE "ReferralQualifyingEvent"
    USING (
      CASE "qualifying_event"::text
        WHEN 'SIGNUP' THEN 'SIGNUP'::"ReferralQualifyingEvent"
        WHEN 'FIRST_RIDE' THEN 'FIRST_RIDE'::"ReferralQualifyingEvent"
        WHEN 'NTH_RIDE' THEN 'NTH_RIDE'::"ReferralQualifyingEvent"
        WHEN 'DRIVER_APPROVED' THEN 'DRIVER_APPROVED'::"ReferralQualifyingEvent"
        WHEN 'DRIVER_FIRST_RIDE' THEN 'DRIVER_FIRST_RIDE'::"ReferralQualifyingEvent"
        WHEN 'DRIVER_NTH_RIDE' THEN 'DRIVER_NTH_RIDE'::"ReferralQualifyingEvent"
        ELSE 'FIRST_RIDE'::"ReferralQualifyingEvent"
      END
    );
EXCEPTION
  WHEN others THEN NULL;
END $$;

ALTER TABLE "referral_programs"
  ALTER COLUMN "qualifying_event" SET DEFAULT 'FIRST_RIDE'::"ReferralQualifyingEvent";

CREATE INDEX IF NOT EXISTS "referral_programs_audience_is_active_valid_from_valid_to_idx"
  ON "referral_programs" ("audience", "is_active", "valid_from", "valid_to");

CREATE TABLE IF NOT EXISTS "referral_milestone_achievements" (
  "id" UUID NOT NULL,
  "milestone_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "referral_id" UUID,
  "reward_id" UUID,
  "achieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "referral_milestone_achievements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "referral_milestone_achievements_milestone_id_user_id_key"
  ON "referral_milestone_achievements" ("milestone_id", "user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "referral_milestone_achievements_reward_id_key"
  ON "referral_milestone_achievements" ("reward_id");
CREATE INDEX IF NOT EXISTS "referral_milestone_achievements_user_id_idx"
  ON "referral_milestone_achievements" ("user_id");

DO $$ BEGIN
  ALTER TABLE "referral_milestone_achievements"
    ADD CONSTRAINT "referral_milestone_achievements_milestone_id_fkey"
    FOREIGN KEY ("milestone_id") REFERENCES "referral_milestones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "referral_milestone_achievements"
    ADD CONSTRAINT "referral_milestone_achievements_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "referral_milestone_achievements"
    ADD CONSTRAINT "referral_milestone_achievements_referral_id_fkey"
    FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "referral_milestone_achievements"
    ADD CONSTRAINT "referral_milestone_achievements_reward_id_fkey"
    FOREIGN KEY ("reward_id") REFERENCES "referral_rewards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "drivers"
  ADD COLUMN IF NOT EXISTS "referral_code_id" UUID;

DO $$ BEGIN
  ALTER TABLE "drivers"
    ADD CONSTRAINT "drivers_referral_code_id_fkey"
    FOREIGN KEY ("referral_code_id") REFERENCES "referral_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
