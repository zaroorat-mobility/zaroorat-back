-- FILES module, phase 7 — the profile-image cutover, deploy 3 (files doc 03 §7.2).
--
-- The contract half of expand->contract. `user_profiles.profile_image_file_id`
-- has been written and read since deploy 1; this removes the URL column it
-- replaced, and with it the last place in the schema where a domain row could
-- hold a URL instead of a file id (FILES-OD-2, doc 01 §13.1).
--
-- **This migration must not ship in the same release as deploy 1.** Old
-- instances still select `profile_image`, and Prisma selects every column of a
-- model it knows about, so a rolling deploy that carried both would fail every
-- profile read on the instances that had not restarted yet. That ordering is the
-- entire reason the cutover was staged rather than done in one edit.
--
-- No data is lost. `userConfig.profileImageHosts` defaulted to empty and the
-- validator was fail-closed, so every URL this column could ever have been given
-- was rejected at write time: it has always been NULL in every environment. The
-- allow-list is deleted in the same change — a private bucket behind signed
-- reads has no host to vouch for (USER §8.5).

ALTER TABLE "user_profiles" DROP COLUMN "profile_image";
