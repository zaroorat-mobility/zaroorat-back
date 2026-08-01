import type { TransactionManager } from '@core/database/TransactionManager';
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
  profileImage: string | null;
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
    profileImage: profile?.profileImage ?? null,
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
   */
  constructor(
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly roleRepository: RoleRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
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
}
