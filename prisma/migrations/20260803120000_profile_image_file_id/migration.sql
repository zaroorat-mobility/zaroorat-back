-- FILES module, phase 7 — the profile-image cutover, deploy 1 (files doc 03 §7.2).
--
-- `user_profiles.profile_image` is a live `String?` URL column. It becomes a
-- file reference **without a rename under running code**, per Database 06's
-- expand->contract rule: this deploy only adds. The old column is dropped in
-- deploy 3, after deploy 2 has been live and nothing reads it.
--
-- Old code is unaffected — it never selects a column it does not know about —
-- which is what doc 06 §7's "the USER suite passes unchanged" asserts.

ALTER TABLE "user_profiles" ADD COLUMN "profile_image_file_id" UUID;

-- R-FILE-33 / FILES-OD-13: a file may be referenced by at most one live domain
-- row. Postgres treats NULLs as distinct, so every profile without an avatar
-- coexists freely while two profiles naming the same file collide.
CREATE UNIQUE INDEX "user_profiles_profile_image_file_id_key"
  ON "user_profiles" ("profile_image_file_id");

-- RESTRICT, not SET NULL: a file row backing a live avatar must not be
-- removable, and a silent NULL would turn a foreign-key violation into a user
-- losing their photograph with nothing in the logs. Nothing hard-deletes a
-- READY file anyway — the sweeper only touches PENDING and EXPIRED rows.
ALTER TABLE "user_profiles"
  ADD CONSTRAINT "user_profiles_profile_image_file_id_fkey"
  FOREIGN KEY ("profile_image_file_id") REFERENCES "files" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── The one-live-profile-image index is retired ──────────────────────────────
--
-- `uq_files_one_live_profile_image` (doc 03 §4.4) allowed a user one READY
-- PROFILE_IMAGE. Together with FLOW §5A's ordering — complete the replacement,
-- *then* attach and supersede — it made avatar replacement impossible: the new
-- file cannot become READY while the old one is, and the old one cannot be
-- superseded until the new one is READY. Neither can go first.
--
-- §4.4's own prose gives the conflict away, saying the old row "must be
-- soft-deleted in the same transaction that readies the new one" — which
-- contradicts R-FILE-31: replacement is never a deletion.
--
-- Resolved in favour of R-FILE-31 by dropping the index. From this deploy on,
-- `user_profiles.profile_image_file_id` is the single answer to "which avatar is
-- current", and the unique index above is what keeps that answer singular. Two
-- constraints answering one question is what created the deadlock; this leaves
-- the one that the attaching module can actually satisfy.
--
-- What it stops guarding: a user may now hold several READY PROFILE_IMAGE rows,
-- only one of them referenced. They are bounded by the per-purpose byte quota
-- (doc 08 §5), which is the mechanism meant to bound them.
DROP INDEX "uq_files_one_live_profile_image";
