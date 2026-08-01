import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { AppPlatform, User, UserDevice, UserSession } from '@core/database/types';
import type { JwtConfig } from '@config/jwt/jwt.config';
import type { SessionConfig } from '@config/session/session.config';
import { UserProfileRepository } from '@modules/users/repositories';
import { userEvent } from '@modules/users/events';
import { UserRepository } from './repositories/user.repository';
import { RoleRepository } from './repositories/role.repository';
import { OtpService, type SendOtpResult } from './otp';
import { TokenService, type TokenPair } from './services';
import { SessionService } from './session';
import { DeviceService } from './session/device.service';
import { AccountSuspendedError } from './errors';
import { authEvent } from './events';

/** The OTP purpose for the unified phone login-or-register flow. */
const AUTH_OTP_PURPOSE = 'LOGIN' as const;
/** Idempotency retention for verify/refresh responses (auth doc 04 §5). */
const IDEMPOTENCY_TTL_SECONDS = 86_400;
/** Canonical role granted to every new account. */
const DEFAULT_ROLE_SLUG = 'customer';

/** Device details captured at login for binding and trust. */
export interface DeviceContext {
  deviceId?: string | null;
  platform?: AppPlatform | null;
  fingerprint?: string | null;
  isRooted?: boolean;
  isJailbroken?: boolean;
  fcmToken?: string | null;
  appVersion?: string | null;
  osVersion?: string | null;
}

/** Inputs to request an OTP. */
export interface SendOtpInput {
  phoneNumber: string;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceFingerprint?: string | null;
}

/** Inputs to verify an OTP and log in / register. */
export interface VerifyOtpInput {
  phoneNumber: string;
  code: string;
  challengeId?: string;
  device?: DeviceContext;
  ip?: string | null;
  userAgent?: string | null;
}

/** Login result: the token pair plus the resolved account snapshot. */
export interface AuthLoginResult extends TokenPair {
  user: { id: string; status: string; roles: string[]; isNew: boolean };
}

/**
 * Top-level authentication orchestrator (auth doc 04).
 *
 * Composes the OTP, token, session, and device modules into the public flows.
 * It owns no low-level mechanics — it sequences them and enforces the
 * cross-cutting rules (account lifecycle, role-based session caps, idempotent
 * verify/refresh). Verification and account creation are self-healing: a retried
 * verify replays via the idempotency key, and a missing default role or profile
 * is re-created on next login.
 */
export class AuthService {
  /**
   * @param otpService OTP send/verify.
   * @param userRepository Identity persistence.
   * @param userProfileRepository USER's profile row, provisioned with the account.
   * @param roleRepository RBAC membership.
   * @param deviceService Device binding/trust.
   * @param sessionService Session lifecycle.
   * @param tokenService Access/refresh issuance and rotation.
   * @param redisService Idempotency store.
   * @param jwtConfig Refresh TTL (session lifetime).
   * @param sessionConfig Concurrency caps.
   */
  constructor(
    private readonly otpService: OtpService,
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly roleRepository: RoleRepository,
    private readonly deviceService: DeviceService,
    private readonly sessionService: SessionService,
    private readonly tokenService: TokenService,
    private readonly redisService: RedisService,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
    private readonly jwtConfig: JwtConfig,
    private readonly sessionConfig: SessionConfig,
  ) {}

  /**
   * Request an OTP (uniform response — never reveals account existence).
   * @param input Phone plus optional device/ip forensics.
   * @returns The challenge response.
   */
  async sendOtp(input: SendOtpInput): Promise<SendOtpResult> {
    return this.otpService.send({
      phoneNumber: input.phoneNumber,
      purpose: AUTH_OTP_PURPOSE,
      ...(input.deviceId != null ? { deviceId: input.deviceId } : {}),
      ...(input.ip != null ? { ip: input.ip } : {}),
      ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
      ...(input.deviceFingerprint != null ? { deviceFingerprint: input.deviceFingerprint } : {}),
    });
  }

  /**
   * Verify an OTP, then log in (or register on first verify) and issue tokens.
   * Idempotent under retry via the optional idempotency key.
   * @param input Phone, code, and optional device/ip/challenge.
   * @param idempotencyKey Client key that replays the stored result on retry.
   * @returns The token pair plus the account snapshot.
   * @throws {OtpInvalidError|OtpExpiredError|OtpLockedError} OTP failures.
   * @throws {AccountSuspendedError} When the resolved account is suspended.
   */
  async verifyOtp(input: VerifyOtpInput, idempotencyKey?: string): Promise<AuthLoginResult> {
    if (idempotencyKey) {
      const cached = await this.redisService.idempotency.get<AuthLoginResult>(idempotencyKey);
      if (cached) return cached;
    }

    await this.otpService.verify({
      phoneNumber: input.phoneNumber,
      purpose: AUTH_OTP_PURPOSE,
      code: input.code,
      ...(input.challengeId ? { challengeId: input.challengeId } : {}),
    });

    // Register/login is one unit of work: the account resolution, the profile
    // row, device binding, session + refresh-token rows, and the audit events all
    // commit in a single transaction (auth doc 06 §2), so a crash can never leave
    // a session without its audit trail. The OTP consume (Redis, above) is the
    // gate; the epoch read during token signing and the concurrency-cap eviction
    // (which revokes *other* sessions in their own transactions) run outside it.
    const outcome = await this.transactionManager.execute(async (tx) => {
      const { user, isNew } = await this.resolveAccount(input.phoneNumber, tx);
      if (user.status === 'SUSPENDED') throw new AccountSuspendedError();

      // USER's profile joins this transaction so an account can never exist
      // without one (user doc 03 §4.1, R-USER-27, USER-INV-1). Idempotent like
      // the default-role grant, so an account that predates this wiring is
      // healed on its next login — and only a real insert announces itself.
      if (await this.userProfileRepository.ensureExists(user.id, tx)) {
        await this.eventPublisher.publish(
          userEvent('user.profile.created', {
            subjectUserId: user.id,
            data: { userId: user.id },
          }),
          tx,
        );
      }

      const device = await this.deviceService.register({ userId: user.id, ...input.device }, tx);
      const roles = await this.roleRepository.findActiveRoleSlugs(user.id, undefined, tx);

      const session = await this.sessionService.createInTransaction(
        {
          userId: user.id,
          deviceId: device.id,
          loginMethod: 'otp',
          expiresAt: new Date(Date.now() + this.jwtConfig.refreshTtlSeconds * 1000),
          ...(input.ip != null ? { ipAddress: input.ip } : {}),
          ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
        },
        tx,
      );

      await this.userRepository.updateLastLoginAt(user.id, new Date(), tx);
      const pair = await this.tokenService.issuePair(
        { userId: user.id, sessionId: session.id, roles },
        tx,
      );

      await this.eventPublisher.publish(
        authEvent('auth.otp.verified', {
          subjectUserId: user.id,
          data: {
            userId: user.id,
            phoneNumber: input.phoneNumber,
            purpose: 'LOGIN',
            isNewAccount: isNew,
          },
        }),
        tx,
      );
      await this.eventPublisher.publish(
        authEvent('auth.login.succeeded', {
          subjectUserId: user.id,
          sessionId: session.id,
          data: {
            userId: user.id,
            sessionId: session.id,
            deviceId: device.id,
            isNewAccount: isNew,
          },
        }),
        tx,
      );
      await this.eventPublisher.publish(
        authEvent('auth.session.created', {
          aggregateId: session.id,
          subjectUserId: user.id,
          sessionId: session.id,
          data: {
            userId: user.id,
            sessionId: session.id,
            deviceId: device.id,
            expiresAt: session.expiresAt.toISOString(),
          },
        }),
        tx,
      );
      if (isNew) {
        await this.eventPublisher.publish(
          authEvent('account.role.granted', {
            subjectUserId: user.id,
            data: { userId: user.id, roleSlug: 'customer' },
          }),
          tx,
        );
      }

      return { user, isNew, roles, session, pair };
    });

    // Concurrency-cap eviction runs after the login commits: it revokes other
    // sessions (each in its own transaction) and must not nest inside the login tx.
    await this.sessionService.enforceCap(
      outcome.user.id,
      this.capForRoles(outcome.roles),
      outcome.session.id,
    );

    const result: AuthLoginResult = {
      ...outcome.pair,
      user: {
        id: outcome.user.id,
        status: outcome.user.status,
        roles: outcome.roles,
        isNew: outcome.isNew,
      },
    };
    if (idempotencyKey) {
      await this.redisService.idempotency.put(idempotencyKey, result, IDEMPOTENCY_TTL_SECONDS);
    }
    return result;
  }

  /**
   * Rotate the session on a presented refresh token. Idempotent under retry (the
   * key distinguishes a legitimate retry from token theft, doc 04 §2.3).
   * @param refreshToken The raw refresh token.
   * @param idempotencyKey Client key that replays the stored result on retry.
   * @returns The rotated token pair.
   * @throws {TokenInvalidError|TokenReuseError} Token failures.
   * @throws {AccountSuspendedError} When the account is no longer active.
   */
  async refresh(refreshToken: string, idempotencyKey?: string): Promise<TokenPair> {
    if (idempotencyKey) {
      const cached = await this.redisService.idempotency.get<TokenPair>(idempotencyKey);
      if (cached) return cached;
    }

    const pair = await this.tokenService.rotate(refreshToken, (userId) =>
      this.resolveActiveRoles(userId),
    );

    if (idempotencyKey) {
      await this.redisService.idempotency.put(idempotencyKey, pair, IDEMPOTENCY_TTL_SECONDS);
    }
    return pair;
  }

  /**
   * Revoke the current session (single logout).
   * @param sessionId Session UUID (`sid`).
   */
  async logout(sessionId: string): Promise<void> {
    await this.sessionService.logout(sessionId);
  }

  /**
   * Revoke every session for a user (logout everywhere; epoch bump).
   * @param userId Owner user UUID.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.sessionService.logoutAll(userId);
  }

  /**
   * List a user's active sessions (self-service session management).
   * @param userId Owner user UUID.
   * @returns Active sessions, oldest first.
   */
  async listSessions(userId: string): Promise<UserSession[]> {
    return this.sessionService.listSessions(userId);
  }

  /**
   * Revoke one of the caller's own sessions.
   * @param userId The caller's user UUID.
   * @param sessionId The session to revoke.
   * @returns `true` if owned and revoked; `false` if unknown or not owned.
   */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.sessionService.revokeForUser(userId, sessionId);
  }

  /**
   * List the devices bound to the caller's account (self-service management).
   *
   * The caller's own device is resolved from the session it is calling with, so
   * the client can mark it and avoid signing itself out by mistake. It comes from
   * the session row rather than the token because the access token carries `sid`,
   * not the device binding.
   *
   * @param userId The caller's user UUID.
   * @param sessionId The caller's current `sid`.
   * @returns The user's devices, newest activity first, and which one is calling.
   */
  async listDevices(
    userId: string,
    sessionId: string,
  ): Promise<{ devices: UserDevice[]; currentDeviceId: string | null }> {
    const [devices, currentDeviceId] = await Promise.all([
      this.deviceService.listDevices(userId),
      this.sessionService.deviceIdFor(sessionId),
    ]);
    return { devices, currentDeviceId };
  }

  /**
   * Revoke one of the caller's own devices: mark it `REVOKED` and end every
   * session bound to it (R-DEVICE-3, AUTH-INV-6). The device must re-register on
   * its next verified login before it can hold a session again.
   * @param userId The caller's user UUID.
   * @param deviceId The device to revoke.
   * @returns Sessions revoked, or `null` if the device is unknown or not owned.
   */
  async revokeDevice(userId: string, deviceId: string): Promise<number | null> {
    return this.deviceService.revokeForUser(userId, deviceId);
  }

  /**
   * Reactivate a suspended account. Restores the ability to authenticate but not
   * old sessions — the user must log in again (R-AUTH-13).
   * @param userId Account UUID.
   */
  async activate(userId: string): Promise<void> {
    // Status change + audit event commit atomically (transactional outbox).
    await this.transactionManager.execute(async (tx) => {
      await this.activateInTransaction(userId, tx);
      await this.eventPublisher.publish(
        authEvent('account.reactivated', {
          subjectUserId: userId,
          data: { userId, actor: 'system' },
        }),
        tx,
      );
    });
  }

  /**
   * Return an account to `ACTIVE` **inside a caller's transaction**, without
   * announcing it.
   *
   * The status column is AUTH's, so the write lives here; the event does not,
   * because which event this is depends on what the account was returning *from*.
   * A reactivation out of ops **suspension** is AUTH's `account.reactivated`
   * ({@link activate}); a restore out of self-**deactivation** is USER's
   * `user.account.restored` — different business events with different
   * notification copy (user doc 05 §3.3). Each caller publishes its own on this
   * transaction.
   *
   * No epoch bump and no session restored: reactivation returns the ability to
   * authenticate, not the credentials that were revoked (R-AUTH-13).
   *
   * @param userId Account UUID.
   * @param tx The caller's transaction client.
   */
  async activateInTransaction(userId: string, tx: TransactionClient): Promise<void> {
    await this.userRepository.updateStatus(userId, 'ACTIVE', tx);
  }

  /**
   * Deactivate an account **inside a caller's transaction**: set the status and
   * end every session, without the epoch bump.
   *
   * Self-service departure is USER's flow (user doc 02 §2.7), but the `status`
   * column and the session tables are AUTH's, so the write lives here — USER never
   * sets `status` with a query of its own (user doc 03 §2). It takes the caller's
   * transaction because USER's audit event has to commit with the status change
   * (R-USER-29); the epoch bump is the caller's job, after commit (R-USER-30),
   * exactly as {@link SessionService.revokeAllInTransaction} splits from `logoutAll`.
   *
   * Idempotent: an account that is already `DEACTIVATED` reports
   * `alreadyDeactivated` and is not written again, so a duplicate request is a
   * no-op rather than a second revocation storm.
   *
   * @param userId Account UUID.
   * @param tx The caller's transaction client.
   * @returns Whether the account was already deactivated, and how many sessions
   *          this call ended.
   */
  async deactivateInTransaction(
    userId: string,
    tx: TransactionClient,
  ): Promise<{ alreadyDeactivated: boolean; sessionsRevoked: number }> {
    const user = await this.userRepository.findById(userId);
    if (user?.status === 'DEACTIVATED') {
      return { alreadyDeactivated: true, sessionsRevoked: 0 };
    }
    await this.userRepository.updateStatus(userId, 'DEACTIVATED', tx);
    const sessionsRevoked = await this.sessionService.revokeAllInTransaction(
      userId,
      'deactivated',
      tx,
    );
    return { alreadyDeactivated: false, sessionsRevoked };
  }

  /**
   * Suspend an account: block access and end all sessions immediately
   * (R-AUTH-12, AUTH-INV-3/4).
   * @param userId Account UUID.
   */
  async suspend(userId: string): Promise<void> {
    // Status change + audit event commit atomically (transactional outbox);
    // session/token revocation + epoch bump follow.
    await this.transactionManager.execute(async (tx) => {
      await this.userRepository.updateStatus(userId, 'SUSPENDED', tx);
      await this.eventPublisher.publish(
        authEvent('account.suspended', {
          subjectUserId: userId,
          data: { userId, actor: 'system' },
        }),
        tx,
      );
    });
    await this.sessionService.logoutAll(userId, 'suspension');
  }

  /** Find the active account for a phone, creating and role-granting on first
   *  verify. Runs inside the login transaction. */
  private async resolveAccount(
    phoneNumber: string,
    tx: TransactionClient,
  ): Promise<{ user: User; isNew: boolean }> {
    const existing = await this.userRepository.findActiveByPhone(phoneNumber, tx);
    if (existing) {
      let user = existing;
      if (!user.isPhoneVerified || user.status === 'UNVERIFIED') {
        await this.userRepository.markPhoneVerified(user.id, tx);
        user = await this.userRepository.updateStatus(user.id, 'ACTIVE', tx);
      }
      await this.ensureDefaultRole(user.id, tx);
      return { user, isNew: false };
    }

    const created = await this.userRepository.create(
      { phoneNumber, status: 'ACTIVE', isPhoneVerified: true },
      tx,
    );
    await this.ensureDefaultRole(created.id, tx);
    return { user: created, isNew: true };
  }

  /** Idempotently grant the default `customer` role within the login transaction. */
  private async ensureDefaultRole(userId: string, tx: TransactionClient): Promise<void> {
    const role = await this.roleRepository.findBySlug(DEFAULT_ROLE_SLUG, tx);
    if (!role) throw new Error(`Default role "${DEFAULT_ROLE_SLUG}" is not seeded`);
    const active = await this.roleRepository.findActiveAssignment(userId, role.id, undefined, tx);
    if (!active) await this.roleRepository.grant({ userId, roleId: role.id }, tx);
  }

  /** Resolve roles for a refresh, rejecting non-active accounts. */
  private async resolveActiveRoles(userId: string): Promise<string[]> {
    const user = await this.userRepository.findById(userId);
    if (!user || user.status !== 'ACTIVE') throw new AccountSuspendedError();
    return this.roleRepository.findActiveRoleSlugs(userId);
  }

  /** Privileged roles get a lower concurrent-session cap. */
  private capForRoles(roles: string[]): number {
    const privileged = roles.includes('admin') || roles.includes('support');
    return privileged
      ? this.sessionConfig.privilegedMaxConcurrentSessions
      : this.sessionConfig.maxConcurrentSessions;
  }
}
