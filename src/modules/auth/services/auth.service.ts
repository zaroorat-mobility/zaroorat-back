import { RedisService, IDEMPOTENCY_OPERATIONS } from '@core/cache';
import { EventPublisher } from '@core/events';
import { TransactionManager } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { AppPlatform, User, UserDevice, UserSession } from '@core/database/types';
import type { JwtConfig } from '@config/jwt/jwt.config';
import type { SessionConfig } from '@config/session/session.config';
import { UserProfileRepository } from '@modules/users/repositories';
import { userEvent } from '@modules/users/events';
import { UserRepository } from '../repositories/user.repository';
import { RoleRepository } from '../repositories/role.repository';
import { OtpService, type SendOtpResult } from './otp/otp.service';
import { TokenService } from './token/token.service';
import { EpochService } from './token/epoch.service';
import type { TokenPair } from './token/token.service';
import { SessionService } from './session/session.service';
import { DeviceService } from './session/device.service';
import { AccountDeactivatedError, AccountSuspendedError } from '../errors/auth.errors';
import { authEvent } from '../events';
import {
  AUTH_OTP_PURPOSE,
  IDEMPOTENCY_TTL_SECONDS,
  DEFAULT_ROLE_SLUG,
} from '../constants/auth.constants';
function isPhoneAlreadyTakenError(err: unknown): boolean {
  const code = (
    err as {
      code?: unknown;
    }
  )?.code;
  const target = (
    err as {
      meta?: {
        target?: unknown;
      };
    }
  )?.meta?.target;
  const targetText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  if (code === 'P2002') {
    return targetText === '' || /phone|uq_users_phone_active/i.test(targetText);
  }
  return (
    /unique constraint failed/i.test((err as Error)?.message ?? '') &&
    /phone/i.test((err as Error)?.message ?? '')
  );
}
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
export interface SendOtpInput {
  phoneNumber: string;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceFingerprint?: string | null;
}
export interface VerifyOtpInput {
  phoneNumber: string;
  code: string;
  challengeId?: string;
  device?: DeviceContext;
  ip?: string | null;
  userAgent?: string | null;
}
export interface AuthLoginResult extends TokenPair {
  user: {
    id: string;
    status: string;
    roles: string[];
    isNew: boolean;
  };
}
export class AuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly roleRepository: RoleRepository,
    private readonly deviceService: DeviceService,
    private readonly sessionService: SessionService,
    private readonly tokenService: TokenService,
    private readonly epochService: EpochService,
    private readonly redisService: RedisService,
    private readonly eventPublisher: EventPublisher,
    private readonly transactionManager: TransactionManager,
    private readonly jwtConfig: JwtConfig,
    private readonly sessionConfig: SessionConfig,
  ) {}
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
  async verifyOtp(input: VerifyOtpInput, idempotencyKey?: string): Promise<AuthLoginResult> {
    if (!idempotencyKey) return this.runVerifyOtp(input);
    return this.redisService.idempotency.runOnce(
      IDEMPOTENCY_OPERATIONS.OTP_VERIFY,
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
      () => this.runVerifyOtp(input),
    );
  }
  private async runVerifyOtp(input: VerifyOtpInput): Promise<AuthLoginResult> {
    await this.otpService.verify({
      phoneNumber: input.phoneNumber,
      purpose: AUTH_OTP_PURPOSE,
      code: input.code,
      ...(input.challengeId ? { challengeId: input.challengeId } : {}),
    });
    const outcome = await this.transactionManager.execute(async (tx) => {
      const { user, isNew } = await this.resolveAccount(input.phoneNumber, tx);
      this.assertAuthenticatable(user);
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
            data: { userId: user.id, roleSlug: DEFAULT_ROLE_SLUG },
          }),
          tx,
        );
      }
      return { user, isNew, roles, session, pair };
    });
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
    return result;
  }
  async refresh(refreshToken: string, idempotencyKey?: string): Promise<TokenPair> {
    const rotate = (): Promise<TokenPair> =>
      this.tokenService.rotate(refreshToken, (userId) => this.resolveActiveRoles(userId));
    if (!idempotencyKey) return rotate();
    return this.redisService.idempotency.runOnce(
      IDEMPOTENCY_OPERATIONS.TOKEN_REFRESH,
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
      rotate,
    );
  }
  async logout(sessionId: string): Promise<void> {
    await this.sessionService.logout(sessionId);
  }
  async logoutAll(userId: string): Promise<void> {
    await this.sessionService.logoutAll(userId);
  }
  async listSessions(userId: string): Promise<UserSession[]> {
    return this.sessionService.listSessions(userId);
  }
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return this.sessionService.revokeForUser(userId, sessionId);
  }
  async listDevices(
    userId: string,
    sessionId: string,
  ): Promise<{
    devices: UserDevice[];
    currentDeviceId: string | null;
  }> {
    const [devices, currentDeviceId] = await Promise.all([
      this.deviceService.listDevices(userId),
      this.sessionService.deviceIdFor(sessionId),
    ]);
    return { devices, currentDeviceId };
  }
  async revokeDevice(userId: string, deviceId: string): Promise<number | null> {
    return this.deviceService.revokeForUser(userId, deviceId);
  }
  async grantRole(
    userId: string,
    roleSlug: string,
    options: {
      grantedBy?: string | null;
      expiresAt?: Date | null;
    } = {},
  ): Promise<boolean> {
    const role = await this.roleRepository.findBySlug(roleSlug);
    if (!role) throw new Error(`Role "${roleSlug}" is not seeded`);
    const granted = await this.transactionManager.execute(async (tx) => {
      const active = await this.roleRepository.findActiveAssignment(userId, role.id, undefined, tx);
      if (active) return false;
      await this.roleRepository.grant(
        {
          userId,
          roleId: role.id,
          ...(options.grantedBy != null ? { grantedBy: options.grantedBy } : {}),
          ...(options.expiresAt != null ? { expiresAt: options.expiresAt } : {}),
        },
        tx,
      );
      await this.eventPublisher.publish(
        authEvent('account.role.granted', {
          subjectUserId: userId,
          data: {
            userId,
            roleSlug,
            ...(options.grantedBy != null ? { grantedBy: options.grantedBy } : {}),
            ...(options.expiresAt != null ? { expiresAt: options.expiresAt.toISOString() } : {}),
          },
        }),
        tx,
      );
      return true;
    });
    if (granted) await this.epochService.bump(userId);
    return granted;
  }
  async revokeRole(
    userId: string,
    roleSlug: string,
    options: {
      revokedBy?: string | null;
      reason?: string | null;
    } = {},
  ): Promise<boolean> {
    const role = await this.roleRepository.findBySlug(roleSlug);
    if (!role) throw new Error(`Role "${roleSlug}" is not seeded`);
    const revoked = await this.transactionManager.execute(async (tx) => {
      const count = await this.roleRepository.revoke(userId, role.id, undefined, tx);
      if (count === 0) return false;
      await this.eventPublisher.publish(
        authEvent('account.role.revoked', {
          subjectUserId: userId,
          data: {
            userId,
            roleSlug,
            ...(options.revokedBy != null ? { revokedBy: options.revokedBy } : {}),
            ...(options.reason != null ? { reason: options.reason } : {}),
          },
        }),
        tx,
      );
      return true;
    });
    if (revoked) await this.epochService.bump(userId);
    return revoked;
  }
  async activate(userId: string): Promise<void> {
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
  async activateInTransaction(userId: string, tx: TransactionClient): Promise<void> {
    await this.userRepository.updateStatus(userId, 'ACTIVE', tx);
  }
  async deactivateInTransaction(
    userId: string,
    tx: TransactionClient,
  ): Promise<{
    alreadyDeactivated: boolean;
    sessionsRevoked: number;
  }> {
    const user = await this.userRepository.findById(userId, tx);
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
  async suspend(userId: string): Promise<void> {
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
  private async resolveAccount(
    phoneNumber: string,
    tx: TransactionClient,
  ): Promise<{
    user: User;
    isNew: boolean;
  }> {
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
    try {
      const created = await this.userRepository.create(
        { phoneNumber, status: 'ACTIVE', isPhoneVerified: true },
        tx,
      );
      await this.ensureDefaultRole(created.id, tx);
      return { user: created, isNew: true };
    } catch (err) {
      if (!isPhoneAlreadyTakenError(err)) throw err;
      const winner = await this.userRepository.findActiveByPhone(phoneNumber, tx);
      if (!winner) throw err;
      await this.ensureDefaultRole(winner.id, tx);
      return { user: winner, isNew: false };
    }
  }
  private assertAuthenticatable(user: Pick<User, 'status' | 'deletedAt'>): void {
    if (user.deletedAt !== null) throw new AccountSuspendedError('This account no longer exists');
    if (user.status === 'DEACTIVATED') throw new AccountDeactivatedError();
    if (user.status !== 'ACTIVE') throw new AccountSuspendedError();
  }
  private async ensureDefaultRole(userId: string, tx: TransactionClient): Promise<void> {
    const role = await this.roleRepository.findBySlug(DEFAULT_ROLE_SLUG, tx);
    if (!role) throw new Error(`Default role "${DEFAULT_ROLE_SLUG}" is not seeded`);
    const active = await this.roleRepository.findActiveAssignment(userId, role.id, undefined, tx);
    if (!active) await this.roleRepository.grant({ userId, roleId: role.id }, tx);
  }
  private async resolveActiveRoles(userId: string): Promise<string[]> {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new AccountSuspendedError();
    this.assertAuthenticatable(user);
    return this.roleRepository.findActiveRoleSlugs(userId);
  }
  private capForRoles(roles: string[]): number {
    const privileged = roles.includes('admin') || roles.includes('support');
    return privileged
      ? this.sessionConfig.privilegedMaxConcurrentSessions
      : this.sessionConfig.maxConcurrentSessions;
  }
}
