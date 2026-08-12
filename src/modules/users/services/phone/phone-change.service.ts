import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import { TransactionManager, UniqueConstraintError } from '@core/database';
import type { JwtConfig } from '@config/jwt/jwt.config';
import { userConfig } from '../../config';
import {
  UserRepository,
  OtpRepository,
  RoleRepository,
  SessionRepository,
} from '@modules/auth/repositories';
import { OtpService } from '@modules/auth/services/otp';
import { SessionService } from '@modules/auth/services/session';
import { TokenService, EpochService } from '@modules/auth/services/token';
import { AccountSuspendedError, OtpInvalidError, RateLimitedError } from '@modules/auth/errors';
import { authEvent } from '@modules/auth/events';

import {
  IDEMPOTENCY_TTL_SECONDS,
  PHONE_CHANGE_PURPOSE,
  RATE_LIMIT_SCOPE,
  REVOKE_REASON,
} from '../../constants';
import { PhoneInUseError, PhoneUnchangedError, UserNotFoundError } from '../../errors';
import { userEvent } from '../../events';
import type { PhoneChangeChallenge, PhoneChangeResult } from '../../schemas';
import { UserMetrics } from '../../metrics';
import { maskPhone } from '../../utils';

export interface RequestPhoneChangeInput {
  userId: string;
  newPhoneNumber: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface VerifyPhoneChangeInput {
  userId: string;
  sessionId: string;
  challengeId: string;
  code: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export { maskPhone };

export class PhoneChangeService {
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

  async verifyPhoneChange(
    input: VerifyPhoneChangeInput,
    idempotencyKey: string,
  ): Promise<PhoneChangeResult> {
    return this.redisService.idempotency.runOnce(idempotencyKey, IDEMPOTENCY_TTL_SECONDS, () =>
      this.runVerifyPhoneChange(input),
    );
  }

  private async runVerifyPhoneChange(input: VerifyPhoneChangeInput): Promise<PhoneChangeResult> {
    const { userId } = input;
    const newPhoneNumber = await this.resolveChallengePhone(input);

    const user = await this.userRepository.findById(userId);
    if (!user || user.deletedAt !== null) throw new UserNotFoundError('Account not found');
    const oldPhoneNumber = user.phoneNumber;

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
      roles: await this.roleRepository.findActiveRoleSlugs(userId),
    });

    this.userMetrics.phoneChangeSucceeded({ userId, sessionsRevoked });

    return {
      ...pair,
      user: { id: userId, phoneNumber: newPhoneNumber, status: user.status },
    };
  }

  private async commitChange(
    input: VerifyPhoneChangeInput,
    oldPhoneNumber: string,
    newPhoneNumber: string,
  ): Promise<number> {
    const { userId } = input;
    try {
      return await this.transactionManager.execute(async (tx) => {
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
      if (err instanceof UniqueConstraintError) throw new PhoneInUseError();
      throw err;
    }
  }

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
