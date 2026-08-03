import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import { TransactionManager, UniqueConstraintError } from '@core/database';
import type { JwtConfig } from '@config/jwt/jwt.config';
import { userConfig } from '@config/user';
import {
  UserRepository,
  OtpRepository,
  RoleRepository,
  SessionRepository,
} from '@modules/auth/repositories';
import { OtpService } from '@modules/auth/otp';
import { SessionService } from '@modules/auth/session';
import { TokenService, EpochService, type TokenPair } from '@modules/auth/services';
import { AccountSuspendedError, OtpInvalidError, RateLimitedError } from '@modules/auth/errors';
import { authEvent } from '@modules/auth/events';
import { userEvent } from './events';
import { PhoneInUseError, PhoneUnchangedError, UserNotFoundError } from './errors';
import { UserMetrics } from './user.metrics';

/** The OTP purpose that scopes a phone-change code (user doc 02 §2.4.1). */
const PHONE_CHANGE_PURPOSE = 'PHONE_CHANGE' as const;
/** Rate-limit scope for the per-account request cap (R-USER-15). */
const RATE_LIMIT_SCOPE = 'user:phone_change';
/** Revocation reason stamped on every session ended by a number change. */
const REVOKE_REASON = 'phone_changed';
/** Idempotency retention for the verify response (doc 02 §5, ~24 h). */
const IDEMPOTENCY_TTL_SECONDS = 86_400;

/** Inputs to request a phone-number change. */
export interface RequestPhoneChangeInput {
  /** Subject from the verified token — never from the body (doc 02 §3). */
  userId: string;
  newPhoneNumber: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** The `202` body of step 1 (doc 02 §2.4.1). */
export interface PhoneChangeChallenge {
  challengeId: string;
  expiresInSec: number;
  resendAvailableInSec: number;
}

/** Inputs to confirm a phone-number change. */
export interface VerifyPhoneChangeInput {
  /** Subject from the verified token. */
  userId: string;
  /** The caller's current `sid`, used to re-bind the new session to this device. */
  sessionId: string;
  challengeId: string;
  code: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** The `200` body of step 2: a fresh pair for the calling device only. */
export interface PhoneChangeResult extends TokenPair {
  user: { id: string; phoneNumber: string; status: string };
}

/**
 * Mask a phone number for an event payload: `+919876500099` → `+9198765•••99`.
 *
 * Doc 05 §5 forbids an unmasked number in any payload — a before/after pair in
 * the event stream is a re-identification gift, and consumers that genuinely need
 * the number read it from the identity under their own access controls. The last
 * two digits are kept because that is what a security notification shows the user
 * so they can recognise their own number; the leading run is kept because a
 * country/operator prefix carries no identifying power on its own.
 *
 * @param phoneNumber An E.164 number.
 * @returns The masked form, never longer than the input.
 */
export function maskPhone(phoneNumber: string): string {
  // Short numbers keep proportionally less, so the mask can never degenerate into
  // the whole number by leading and trailing runs overlapping.
  const leading = Math.min(8, Math.max(0, phoneNumber.length - 5));
  return `${phoneNumber.slice(0, leading)}•••${phoneNumber.slice(-2)}`;
}

/**
 * The two-step phone-number change (user doc 02 §2.4, FLOW §4).
 *
 * Step 1 sends an OTP to the **new** number; step 2 consumes it and re-binds the
 * identity. Proving control of the *old* number is never sufficient (R-USER-10) —
 * that is the whole point of sending to the target.
 *
 * Split out of {@link UserService} because it composes a different half of AUTH:
 * OTP, sessions, tokens, and the epoch, none of which the profile endpoints touch.
 * It mirrors AUTH's own decomposition rather than growing one service that
 * happens to own two unrelated dependency graphs.
 *
 * **Two rules shape the whole flow.** The number update, the session revocation,
 * and their events are one transaction (R-USER-29) — no partial outcome exists.
 * The epoch bump and the replacement session run *after* that commit (R-USER-30):
 * signing a token inside the transaction would mint a pair the very next line
 * invalidates.
 */
export class PhoneChangeService {
  /**
   * @param userRepository AUTH's identity persistence (the `phone_number` write).
   * @param otpService AUTH's OTP send/verify — USER never touches MSG91 or Redis' OTP keys.
   * @param otpRepository Resolves a `challengeId` back to its phone/purpose/owner.
   * @param roleRepository Live role slugs for the replacement access token.
   * @param sessionService Transactional bulk revocation (R-USER-13).
   * @param sessionRepository Reads the calling session's device binding.
   * @param tokenService Issues the replacement pair.
   * @param epochService Post-commit epoch bump (what makes every old token stale).
   * @param redisService Per-account rate limiting and stored-response idempotency.
   * @param eventPublisher Transactional-outbox publisher.
   * @param transactionManager Unit-of-work boundary.
   * @param userMetrics Phone-change counters (doc 05 §6).
   * @param jwtConfig Refresh TTL, which is the replacement session's lifetime.
   */
  constructor(
    private readonly userRepository: UserRepository,
    private readonly otpService: OtpService,
    private readonly otpRepository: OtpRepository,
    private readonly roleRepository: RoleRepository,
    private readonly sessionService: SessionService,
    private readonly sessionRepository: SessionRepository,
    private readonly tokenService: TokenService,
    private readonly epochService: EpochService,
    private readonly redisService: RedisService,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
    private readonly userMetrics: UserMetrics,
    private readonly jwtConfig: JwtConfig,
  ) {}

  /**
   * Step 1 — send an OTP to the number the caller wants to move to.
   *
   * The per-account cap is checked **first**, before any lookup: a limit that only
   * applies to requests which got as far as a database read is not a limit on the
   * enumeration this endpoint deliberately allows (doc 02 §2.4.1).
   *
   * @param input Subject, target number, and correlation id.
   * @returns The challenge the client presents at step 2.
   * @throws {RateLimitedError} The account exceeded its request cap (R-USER-15).
   * @throws {UserNotFoundError} The identity no longer exists.
   * @throws {AccountSuspendedError} The account is not in a changeable state (R-USER-9).
   * @throws {PhoneUnchangedError} The target is the number already held.
   * @throws {PhoneInUseError} Another active account holds the target.
   */
  async requestPhoneChange(input: RequestPhoneChangeInput): Promise<PhoneChangeChallenge> {
    const { userId, newPhoneNumber } = input;

    const decision = await this.redisService.rateLimit.hit(
      RATE_LIMIT_SCOPE,
      userId,
      userConfig.phoneChangeRequestLimit,
      userConfig.phoneChangeWindowSeconds,
    );
    if (!decision.allowed) {
      this.userMetrics.phoneRateLimited({ userId });
      throw new RateLimitedError(decision.retryAfterSeconds);
    }

    const user = await this.userRepository.findById(userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    if (user.status !== 'ACTIVE') throw new AccountSuspendedError();
    if (user.phoneNumber === newPhoneNumber) throw new PhoneUnchangedError();

    const holder = await this.userRepository.findActiveByPhone(newPhoneNumber);
    if (holder && holder.id !== userId) throw new PhoneInUseError();

    // `ip`/`userAgent` are forwarded so AUTH's per-IP send axis and its OTP audit
    // trail cover this path too. Without them a caller holding several hijacked
    // sessions would walk a range of numbers under only the per-account cap above.
    const challenge = await this.otpService.send({
      phoneNumber: newPhoneNumber,
      purpose: PHONE_CHANGE_PURPOSE,
      userId,
      ...(input.ip != null ? { ip: input.ip } : {}),
      ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
    });

    await this.eventPublisher.publish(
      userEvent('user.phone.change_requested', {
        subjectUserId: userId,
        requestId: input.requestId ?? null,
        data: {
          userId,
          challengeId: challenge.challengeId,
          newPhoneMasked: maskPhone(newPhoneNumber),
        },
      }),
    );
    this.userMetrics.phoneChangeRequested({ userId });

    return challenge;
  }

  /**
   * Step 2 — consume the OTP and re-bind the identity to the new number.
   *
   * Idempotent under retry: a repeat with the same key replays the stored pair
   * rather than consuming a second code and revoking the session it just issued
   * (doc 02 §5).
   *
   * @param input Subject, current `sid`, challenge, and code.
   * @param idempotencyKey The client's `Idempotency-Key`.
   * @returns A fresh pair for the calling device, plus the updated account.
   * @throws {OtpInvalidError|OtpExpiredError|OtpLockedError} OTP failures.
   * @throws {PhoneInUseError} Another account took the number first (lost race).
   * @throws {UserNotFoundError} The identity no longer exists.
   */
  async verifyPhoneChange(
    input: VerifyPhoneChangeInput,
    idempotencyKey: string,
  ): Promise<PhoneChangeResult> {
    const cached = await this.redisService.idempotency.get<PhoneChangeResult>(idempotencyKey);
    if (cached) return cached;

    const { userId } = input;
    const newPhoneNumber = await this.resolveChallengePhone(input);

    const user = await this.userRepository.findById(userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    const oldPhoneNumber = user.phoneNumber;

    // Read the device binding before the revocation wipes the session set: the
    // replacement session must land on the same device, and after commit there is
    // no active row left to read it from.
    const current = await this.sessionRepository.findById(input.sessionId);

    try {
      await this.otpService.verify({
        phoneNumber: newPhoneNumber,
        purpose: PHONE_CHANGE_PURPOSE,
        code: input.code,
        challengeId: input.challengeId,
      });
    } catch (err) {
      this.userMetrics.phoneChangeFailed({ userId, reason: 'otp' });
      throw err;
    }

    const sessionsRevoked = await this.commitChange(input, oldPhoneNumber, newPhoneNumber);

    // Everything below is a non-transactional side effect and runs only after the
    // commit (R-USER-30). The epoch bump is what actually makes every token issued
    // before this moment stale (USER-INV-4), so the replacement pair must be
    // signed *after* it — sign first and the bump invalidates it on arrival.
    await this.epochService.bump(userId);

    const session = await this.sessionService.create({
      userId,
      loginMethod: 'phone_change',
      expiresAt: new Date(Date.now() + this.jwtConfig.refreshTtlSeconds * 1000),
      ...(current?.deviceId != null ? { deviceId: current.deviceId } : {}),
      ...(input.ip != null ? { ipAddress: input.ip } : {}),
      ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
    });
    const pair = await this.tokenService.issuePair({
      userId,
      sessionId: session.id,
      // Read live from `user_roles`, not carried over from the caller's old token:
      // the change preserves the identity and therefore its roles (R-USER-11), and
      // the table is the only thing that can say what they are right now.
      roles: await this.roleRepository.findActiveRoleSlugs(userId),
    });

    this.userMetrics.phoneChangeSucceeded({ userId, sessionsRevoked });

    const result: PhoneChangeResult = {
      ...pair,
      user: { id: userId, phoneNumber: newPhoneNumber, status: user.status },
    };
    await this.redisService.idempotency.put(idempotencyKey, result, IDEMPOTENCY_TTL_SECONDS);
    return result;
  }

  /**
   * The single unit of work: re-check uniqueness, move the number, revoke every
   * session, and write the audit trail — all or nothing (R-USER-29).
   * @returns The number of sessions revoked, which is also the number of
   *          `auth.session.revoked` events written in the same transaction.
   */
  private async commitChange(
    input: VerifyPhoneChangeInput,
    oldPhoneNumber: string,
    newPhoneNumber: string,
  ): Promise<number> {
    const { userId } = input;
    try {
      return await this.transactionManager.execute(async (tx) => {
        // Re-checked here and not only at step 1, because two users racing for the
        // same free number both passed that check. This one is a courtesy for the
        // error message — the partial unique index is the actual enforcement
        // (doc 03 §4.2), which is why the `catch` below exists at all.
        const holder = await this.userRepository.findActiveByPhone(newPhoneNumber, tx);
        if (holder && holder.id !== userId) throw new PhoneInUseError();

        await this.userRepository.updatePhoneNumber(userId, newPhoneNumber, tx);
        const sessionsRevoked = await this.sessionService.revokeAllInTransaction(
          userId,
          REVOKE_REASON,
          tx,
        );

        await this.eventPublisher.publish(
          userEvent('user.phone.changed', {
            subjectUserId: userId,
            requestId: input.requestId ?? null,
            data: {
              userId,
              oldPhoneMasked: maskPhone(oldPhoneNumber),
              newPhoneMasked: maskPhone(newPhoneNumber),
              sessionsRevoked,
            },
          }),
          tx,
        );
        // AUTH's event, not a USER near-duplicate (doc 05 §3.2, USER-OD-4). This
        // flow is its first and only trigger.
        await this.eventPublisher.publish(
          authEvent('account.recovery.completed', {
            subjectUserId: userId,
            requestId: input.requestId ?? null,
            data: { userId, actor: 'self', changedPhone: true },
          }),
          tx,
        );

        return sessionsRevoked;
      });
    } catch (err) {
      this.userMetrics.phoneChangeFailed({
        userId,
        reason:
          err instanceof PhoneInUseError || err instanceof UniqueConstraintError
            ? 'taken'
            : 'error',
      });
      // The loser of a race reaches the `UPDATE` before the winner commits, so its
      // re-check above saw nothing and the index rejected the write instead. Both
      // paths are the same answer to the client (doc 02 §2.4.2).
      if (err instanceof UniqueConstraintError) throw new PhoneInUseError();
      throw err;
    }
  }

  /**
   * Resolve a `challengeId` to the number it was sent to, refusing anything that
   * is not this caller's live phone-change challenge.
   *
   * The verify body carries no phone number (doc 02 §2.4.2), and that is a feature:
   * the target is read from the challenge AUTH already recorded, so a caller cannot
   * present a code minted for one number against another. Binding on `userId`
   * additionally stops one user redeeming another's challenge. Every rejection is
   * the same `OTP_INVALID` AUTH uses, so nothing here becomes an oracle.
   */
  private async resolveChallengePhone(input: VerifyPhoneChangeInput): Promise<string> {
    const challenge = await this.otpRepository.findById(input.challengeId);
    if (
      !challenge ||
      challenge.purpose !== PHONE_CHANGE_PURPOSE ||
      challenge.userId !== input.userId ||
      challenge.verifiedAt !== null
    ) {
      this.userMetrics.phoneChangeFailed({ userId: input.userId, reason: 'challenge' });
      throw new OtpInvalidError();
    }
    return challenge.phoneNumber;
  }
}
