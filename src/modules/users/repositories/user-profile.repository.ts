import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { UserProfile } from '../types';

/**
 * A partial profile write. Only the keys **present** on this object are written;
 * an absent key leaves its column unchanged, an explicit `null` clears it
 * (R-USER-5, doc 02 §2.2). That distinction is the reason this is not a blind
 * object merge.
 */
export interface UpdateUserProfileInput {
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: Date | null;
  gender?: string | null;
  /**
   * The avatar as a **file id**, never a URL (FILES-OD-2). A stored URL is
   * either public — which violates R-FILE-11 — or expired, and therefore
   * useless. The client exchanges this id for a short-lived signed URL at
   * `GET /files/{id}/url`.
   */
  profileImageFileId?: string | null;
  languageCode?: string | null;
}

/**
 * Data access for `user_profiles` — the 1:1 profile owned by this module
 * (user doc 03 §3.1). Prisma-only, no business rules.
 *
 * The "exactly one profile per account" invariant (USER-INV-1) is enforced in
 * two places, neither of them here: the `user_id @unique` constraint covers the
 * "at most one" side, and AUTH's registration transaction covers "at least one".
 */
export class UserProfileRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Fetch the profile belonging to an account.
   * @param userId Owner's user UUID.
   * @param tx Transaction client to join (omit for a standalone read).
   * @returns The profile, or `null` if the account has none yet.
   */
  async findByUserId(userId: string, tx?: TransactionClient): Promise<UserProfile | null> {
    return (tx ?? this.client).userProfile.findUnique({ where: { userId } });
  }

  /**
   * Create the empty profile that accompanies a new account, if it has none.
   * Every attribute is `null` except `languageCode`, which takes the schema
   * default (doc 03 §3.1) — registration collects a phone number and nothing
   * else (R-USER-2).
   *
   * `createMany({ skipDuplicates })` compiles to `ON CONFLICT DO NOTHING`, which
   * is what makes this callable on every login rather than only on registration:
   * a plain `create` would raise a unique violation, and an error raised inside
   * an interactive transaction aborts the whole login, not just this statement.
   *
   * @param userId Owner's user UUID.
   * @param tx AUTH's registration transaction (R-USER-27).
   * @returns `true` if this call created the row, `false` if one already existed
   *          — the caller emits `user.profile.created` only on a real insert.
   */
  async ensureExists(userId: string, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).userProfile.createMany({
      data: { userId },
      skipDuplicates: true,
    });
    return count === 1;
  }

  /**
   * Whether any profile still names this file as its avatar (R-FILE-19).
   *
   * The answer `files` cannot work out for itself: it holds no foreign key to
   * this table by design, so it asks the owning module instead. Registered as
   * the `PROFILE_IMAGE` reference check in the module's DI wiring, and it is
   * what stops retention erasing an avatar somebody is still wearing
   * (FILE-INV-5).
   * @param fileId The file being released or attached.
   * @param tx The asking transaction, so an uncommitted attach is visible.
   * @returns `true` while a profile references it.
   */
  async isProfileImage(fileId: string, tx?: TransactionClient): Promise<boolean> {
    const count = await (tx ?? this.client).userProfile.count({
      where: { profileImageFileId: fileId },
    });
    return count > 0;
  }

  /**
   * Apply a partial profile update, creating the row if the account has none.
   *
   * The upsert is not a workaround for a missing constraint: profile creation
   * belongs to AUTH's registration transaction (R-USER-27), which now provisions
   * one on every login. A token issued before that wiring — or refreshed ever
   * since, since refresh never re-enters `verifyOtp` — can still belong to an
   * account with no profile row. Upserting keeps `PATCH` correct in both worlds
   * and can never produce a second row: `user_id` is unique, so a concurrent
   * insert loses on the constraint.
   *
   * @param userId Owner's user UUID.
   * @param input The keys to write (absent ⇒ unchanged, `null` ⇒ cleared).
   * @param tx Transaction client to join, so the row change and its outbox event
   *           commit together (R-USER-28).
   * @returns The profile as it stands after the write.
   */
  async update(
    userId: string,
    input: UpdateUserProfileInput,
    tx?: TransactionClient,
  ): Promise<UserProfile> {
    const data: UpdateUserProfileInput = {};
    if ('firstName' in input) data.firstName = input.firstName;
    if ('lastName' in input) data.lastName = input.lastName;
    if ('dateOfBirth' in input) data.dateOfBirth = input.dateOfBirth;
    if ('gender' in input) data.gender = input.gender;
    if ('profileImageFileId' in input) data.profileImageFileId = input.profileImageFileId;
    if ('languageCode' in input) data.languageCode = input.languageCode;

    return (tx ?? this.client).userProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /**
   * Delete an account's profile (account erasure, R-USER-18/19).
   *
   * A hard delete: doc 03 §6 says the profile "lives and dies with the account",
   * and a soft-deleted profile is a retained name and date of birth.
   *
   * This also releases the avatar's `RESTRICT` foreign key, which is why the
   * erasure job removes the file **after** this and not before — FILES refuses
   * to delete an object a live row still references, and that refusal is the
   * guard working.
   *
   * @param userId Owner's user UUID.
   * @param tx Transaction client to join.
   * @returns Count removed (0 or 1) — reported in the erasure audit event.
   */
  async deleteForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).userProfile.deleteMany({ where: { userId } });
    return count;
  }
}
