import type { TransactionClient, TransactionManager } from '@core/database/TransactionManager';
import type { FileService } from '@modules/files';
import type { EventPublisher } from '@core/events';
import type { User } from '@core/database/types';
import { userConfig } from '@config/user';
import type { RoleRepository, UserRepository } from '@modules/auth/repositories';
import { UserProfileRepository, type UpdateUserProfileInput } from './repositories';
import { userEvent } from './events';
import { UserNotFoundError } from './errors';
import type { UserProfile } from './types';

/** The profile projection returned by the API (doc 02 §2.1). */
export interface UserProfileView {
  firstName: string | null;
  lastName: string | null;
  /** `YYYY-MM-DD` — date-only, no instant and no timezone (doc 03 §3.1). */
  dateOfBirth: string | null;
  gender: string | null;
  /**
   * The avatar's **file id**, which the client exchanges for a short-lived
   * signed URL at `GET /files/{id}/url` (FILES-OD-2).
   *
   * Not a URL, and there is deliberately no URL here: one minted at profile-read
   * time would be a bearer credential with somebody else's expiry, cached by
   * every client that stores the profile.
   */
  profileImageFileId: string | null;
  languageCode: string | null;
  referralCode: string | null;
}

/** The full "who am I" projection returned by `GET /me` (doc 02 §2.1). */
export interface UserAccountView {
  id: string;
  phoneNumber: string;
  email: string | null;
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  status: string;
  roles: string[];
  createdAt: Date;
  lastLoginAt: Date | null;
  profile: UserProfileView;
}

/**
 * Render a `@db.Date` column as a calendar date.
 *
 * The column is `date`, so Prisma hands back midnight UTC and the first ten
 * characters are the stored day. Formatting through a local-timezone accessor
 * instead is the classic off-by-one that shows a user born on the 1st as the
 * 31st (doc 03 §3.1).
 */
function toDateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * Present a profile row, or the empty profile of an account that has none.
 *
 * `profile` is never `null` on the wire (doc 02 §2.1): a fresh account returns
 * every attribute `null` except `languageCode`. Accounts registered before
 * profile creation joined AUTH's registration transaction have no row, and they
 * must read identically to accounts that do.
 */
function toProfileView(profile: UserProfile | null): UserProfileView {
  return {
    firstName: profile?.firstName ?? null,
    lastName: profile?.lastName ?? null,
    dateOfBirth: toDateOnly(profile?.dateOfBirth ?? null),
    gender: profile?.gender ?? null,
    profileImageFileId: profile?.profileImageFileId ?? null,
    languageCode: profile?.languageCode ?? userConfig.defaultLanguageCode,
    referralCode: profile?.referralCode ?? null,
  };
}

/** Compose the account view from its three reads. */
function toAccountView(user: User, profile: UserProfile | null, roles: string[]): UserAccountView {
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    email: user.email,
    isPhoneVerified: user.isPhoneVerified,
    isEmailVerified: user.isEmailVerified,
    status: user.status,
    roles,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    profile: toProfileView(profile),
  };
}

/**
 * Self-service identity and profile operations (user doc 02 §2.1–§2.2).
 *
 * Every method takes the subject `userId` from the caller's **verified token** —
 * there is no path, query, or body identifier anywhere in this module, which is
 * what makes USER-INV-2 a property of the design rather than of each handler.
 *
 * This service owns no authentication, no session, and no role mechanics: it
 * reads AUTH's `users` and `user_roles` tables (permitted by doc 03 §2) and calls
 * AUTH's services for anything that changes them.
 */
export class UserService {
  /**
   * @param userRepository AUTH's identity repository (read-only here).
   * @param userProfileRepository This module's profile persistence.
   * @param roleRepository AUTH's RBAC membership (read-only here).
   * @param transactionManager Unit-of-work boundary for state + outbox writes.
   * @param eventPublisher Transactional-outbox publisher.
   * @param fileService FILES' module-to-module surface — the reference check and
   *        supersession that an avatar change runs inside this module's own
   *        transaction (R-FILE-27). Nothing else about storage crosses here: no
   *        bucket, no key, no URL.
   */
  constructor(
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly roleRepository: RoleRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly fileService: FileService,
  ) {}

  /**
   * Read the caller's account, profile, and live role slugs.
   *
   * `roles` comes from `user_roles`, **not** from the token's claim: a grant made
   * after the current access token was minted is visible here immediately, one
   * epoch before the token catches up (doc 02 §2.1).
   *
   * Three primary-key reads, issued concurrently and asserted as a bounded query
   * count by the test plan (doc 06 §7) — this is the only hot path in the module.
   *
   * @param userId Subject from the verified token.
   * @returns The account view.
   * @throws {UserNotFoundError} If the identity no longer exists.
   */
  async getMe(userId: string): Promise<UserAccountView> {
    const [user, profile, roles] = await Promise.all([
      this.userRepository.findById(userId),
      this.userProfileRepository.findByUserId(userId),
      this.roleRepository.findActiveRoleSlugs(userId),
    ]);
    if (!user || user.deletedAt !== null) {
      throw new UserNotFoundError('Account not found');
    }
    return toAccountView(user, profile, roles);
  }

  /**
   * Apply a partial profile update and record it.
   *
   * The row change and its `user.profile.updated` outbox row commit in one
   * transaction (R-USER-28): a rolled-back update emits nothing, and a committed
   * one never loses its event. The event carries the changed **field names**
   * only — a profile edit is not worth shipping a date of birth through the
   * broker (doc 05 §5).
   *
   * Immutable-field rejection happens at the HTTP edge before this is called, so
   * `changes` can only contain writable keys by the time it arrives.
   *
   * @param userId Subject from the verified token.
   * @param changes Keys to write; absent ⇒ unchanged, `null` ⇒ cleared.
   * @param requestId Correlation id for the event envelope.
   * @returns The profile as it stands after the write.
   */
  async updateProfile(
    userId: string,
    changes: UpdateUserProfileInput,
    requestId: string | null = null,
  ): Promise<UserProfileView> {
    const changedFields = Object.keys(changes);

    // An empty PATCH is a no-op: no write, and no event claiming a change that
    // did not happen. Reading back keeps the response shape identical either way.
    if (changedFields.length === 0) {
      return toProfileView(await this.userProfileRepository.findByUserId(userId));
    }

    const profile = await this.transactionManager.execute(async (tx) => {
      if ('profileImageFileId' in changes) {
        await this.attachProfileImage(userId, changes.profileImageFileId ?? null, tx, requestId);
      }
      const updated = await this.userProfileRepository.update(userId, changes, tx);
      await this.eventPublisher.publish(
        userEvent('user.profile.updated', {
          subjectUserId: userId,
          requestId,
          data: { userId, changedFields },
        }),
        tx,
      );
      return updated;
    });

    return toProfileView(profile);
  }

  /**
   * Attach a file as the caller's avatar, superseding the one it replaces
   * (R-FILE-31, files doc 02 §6A, FLOW §5A).
   *
   * **Runs inside the caller's transaction** (R-FILE-27), which is the whole
   * point of `files` exposing a `tx`-accepting check: the referenceability
   * question and the write that depends on it commit together, so a check that
   * passed can never be stale by the time the column lands.
   *
   * The old version is **superseded, never deleted**. A deletion says "the user
   * withdrew it"; supersession says "this was valid until now", and only the
   * second is true of a photograph someone replaced. Clearing the avatar
   * outright is the exception: with no successor there is no chain to extend
   * (`ck_files_superseded_has_successor` would refuse one), so the file simply
   * becomes unreferenced and the owner may delete it.
   *
   * There is no replace endpoint anywhere: replacement is upload, then attach,
   * and the attach belongs to whoever stores the id.
   *
   * @param userId The account whose avatar is changing.
   * @param nextFileId The new avatar, or `null` to clear it.
   * @param tx This method's caller's transaction.
   * @param requestId Correlation id for the `file.superseded` envelope.
   * @throws {FileNotFoundError} The file is absent, not this user's, or not a
   *         `PROFILE_IMAGE` — all indistinguishable (FILE-INV-4).
   * @throws {FileStateError} The file exists but its bytes were never verified.
   */
  private async attachProfileImage(
    userId: string,
    nextFileId: string | null,
    tx: TransactionClient,
    requestId: string | null,
  ): Promise<void> {
    const current = (await this.userProfileRepository.findByUserId(userId, tx))?.profileImageFileId;
    // Re-submitting the avatar already in place is a no-op, not a conflict: the
    // reference check would otherwise refuse the file for being referenced by
    // the very row about to be rewritten (R-FILE-33).
    if ((current ?? null) === nextFileId) return;

    if (nextFileId === null) return;

    await this.fileService.assertReferenceable(nextFileId, userId, 'PROFILE_IMAGE', tx);
    if (current != null) {
      await this.fileService.supersede(current, nextFileId, tx, requestId);
    }
  }
}
