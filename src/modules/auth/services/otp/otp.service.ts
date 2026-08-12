import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import type { OtpPurpose } from '@core/database/types';
import type { OtpConfig } from '@config/otp/otp.config';
import { logger } from '@shared/logger/index.js';
import { NotificationService } from '@modules/notifications';
import { authEvent } from '../../events';
import {
  OtpRepository,
  type OtpOutcome,
  type UpdateOutcomeOptions,
} from '../../repositories/otp.repository';
import {
  OtpExpiredError,
  OtpInvalidError,
  OtpLockedError,
  RateLimitedError,
} from '../../errors/auth.errors';
import { OtpGenerator } from './otp.generator';
import { OtpHasher } from './otp.hasher';
import { OtpValidator } from './otp.validator';
import { OtpRateLimiter } from './otp.rate-limiter';
import { OtpMetrics } from '../../metrics';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export interface SendOtpInput {
  phoneNumber: string;
  purpose: OtpPurpose;
  userId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  deviceFingerprint?: string | null;
  userAgent?: string | null;
}

export interface SendOtpResult {
  challengeId: string;
  expiresInSec: number;
  resendAvailableInSec: number;
}

export interface VerifyOtpInput {
  phoneNumber: string;
  purpose: OtpPurpose;
  code: string;
  challengeId?: string;
}

export class OtpService {
  constructor(
    private readonly otpGenerator: OtpGenerator,
    private readonly otpHasher: OtpHasher,
    private readonly otpValidator: OtpValidator,
    private readonly otpRateLimiter: OtpRateLimiter,
    private readonly redisService: RedisService,
    private readonly otpRepository: OtpRepository,
    private readonly notificationService: NotificationService,
    private readonly otpMetrics: OtpMetrics,
    private readonly eventPublisher: EventPublisher,
    private readonly otpConfig: OtpConfig,
  ) {}

  async send(input: SendOtpInput): Promise<SendOtpResult> {
    const { phoneNumber, purpose } = input;

    const active = await this.redisService.otp.getChallenge(purpose, phoneNumber);
    if (active) {
      return {
        challengeId: active.challengeId,
        expiresInSec: Math.max(0, Math.ceil((active.otpExpiresAt - Date.now()) / 1000)),
        resendAvailableInSec: active.resendTtlSeconds,
      };
    }

    const decision = await this.otpRateLimiter.checkSend({
      phoneNumber,
      deviceId: input.deviceId ?? null,
      ip: input.ip ?? null,
    });
    if (!decision.allowed) {
      this.otpMetrics.rateLimited({ purpose });
      throw new RateLimitedError(decision.retryAfterSeconds);
    }

    const code = this.otpGenerator.generate();
    const otpExpiresAt = Date.now() + this.otpConfig.ttlSeconds * 1000;
    await this.redisService.otp.store(
      purpose,
      phoneNumber,
      this.otpHasher.hash(code),
      this.otpConfig.ttlSeconds,
    );

    await this.eventPublisher.publish(
      authEvent('auth.otp.requested', { data: { phoneNumber, purpose } }),
    );

    const startedAt = performance.now();
    const delivery = await this.notificationService.sendOtp(phoneNumber, code);
    const latencyMs = Math.round(performance.now() - startedAt);

    const trail = await this.otpRepository.create({
      phoneNumber,
      purpose,
      outcome: 'sent',
      expiresAt: new Date(otpExpiresAt),
      provider: delivery.provider,
      latencyMs,
      ...(input.userId != null ? { userId: input.userId } : {}),
      ...(isUuid(input.deviceId) ? { deviceId: input.deviceId } : {}),
      ...(input.ip != null ? { ipAddress: input.ip } : {}),
      ...(input.deviceFingerprint != null ? { deviceFingerprint: input.deviceFingerprint } : {}),
      ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
      ...(delivery.providerRef != null ? { providerRef: delivery.providerRef } : {}),
      ...(delivery.accepted ? {} : { failureReason: delivery.error ?? 'delivery_not_accepted' }),
    });

    await this.redisService.otp.setChallenge(
      purpose,
      phoneNumber,
      { challengeId: trail.id, otpExpiresAt },
      this.otpConfig.resendIntervalSeconds,
    );

    if (!delivery.accepted) {
      this.otpMetrics.providerFailure({ provider: delivery.provider });
      logger.warn(
        { challengeId: trail.id, provider: delivery.provider, error: delivery.error },
        '[OTP] delivery not accepted by provider',
      );
    } else {
      this.otpMetrics.sent({ provider: delivery.provider, latencyMs });
      await this.eventPublisher.publish(
        authEvent('auth.otp.sent', {
          data: {
            phoneNumber,
            purpose,
            provider: delivery.provider,
            providerRef: delivery.providerRef ?? null,
          },
        }),
      );
    }

    return {
      challengeId: trail.id,
      expiresInSec: this.otpConfig.ttlSeconds,
      resendAvailableInSec: this.otpConfig.resendIntervalSeconds,
    };
  }

  async verify(input: VerifyOtpInput): Promise<void> {
    const { phoneNumber, purpose } = input;

    if (await this.otpRateLimiter.isLocked(phoneNumber)) {
      throw new OtpLockedError(this.otpConfig.lockoutSeconds);
    }

    await this.assertChallengeBelongsToCaller(input);

    const matched =
      this.otpValidator.isValidFormat(input.code) &&
      (await this.redisService.otp.consume(purpose, phoneNumber, this.otpHasher.hash(input.code)));

    if (matched) {
      await this.otpRateLimiter.clearAttempts(phoneNumber);
      await this.redisService.otp.clearChallenge(purpose, phoneNumber);
      await this.recordOutcome(input.challengeId, 'verified', { verifiedAt: new Date() });
      this.otpMetrics.success({ purpose });
      return;
    }

    if (await this.isExpiredChallenge(input.challengeId)) {
      await this.recordOutcome(input.challengeId, 'expired', { failureReason: 'expired' });
      this.otpMetrics.expired({ purpose });
      throw new OtpExpiredError();
    }

    const { locked } = await this.otpRateLimiter.registerFailedAttempt(phoneNumber);
    await this.recordOutcome(input.challengeId, locked ? 'locked' : 'failed', {
      failureReason: locked ? 'locked_out' : 'wrong_code',
    });
    await this.eventPublisher.publish(
      authEvent('auth.login.failed', {
        data: { phoneNumber, purpose, reason: locked ? 'locked' : 'invalid' },
      }),
    );
    if (locked) {
      await this.notifyLocked(phoneNumber);
      this.otpMetrics.locked({ purpose });
      throw new OtpLockedError(this.otpConfig.lockoutSeconds);
    }
    this.otpMetrics.failed({ purpose });
    throw new OtpInvalidError();
  }

  private async assertChallengeBelongsToCaller(input: VerifyOtpInput): Promise<void> {
    if (!input.challengeId) return;

    const challenge = await this.otpRepository.findById(input.challengeId);
    const bound =
      !!challenge &&
      challenge.phoneNumber === input.phoneNumber &&
      challenge.purpose === input.purpose &&
      challenge.verifiedAt === null;
    if (bound) return;

    const { locked } = await this.otpRateLimiter.registerFailedAttempt(input.phoneNumber);
    await this.eventPublisher.publish(
      authEvent('auth.login.failed', {
        data: {
          phoneNumber: input.phoneNumber,
          purpose: input.purpose,
          reason: locked ? 'locked' : 'invalid',
        },
      }),
    );
    if (locked) {
      await this.notifyLocked(input.phoneNumber);
      this.otpMetrics.locked({ purpose: input.purpose });
      throw new OtpLockedError(this.otpConfig.lockoutSeconds);
    }
    this.otpMetrics.failed({ purpose: input.purpose });
    throw new OtpInvalidError();
  }

  private async isExpiredChallenge(challengeId: string | undefined): Promise<boolean> {
    if (!challengeId) return false;
    const row = await this.otpRepository.findById(challengeId);
    return !!row && !row.verifiedAt && row.expiresAt.getTime() <= Date.now();
  }

  private async notifyLocked(phoneNumber: string): Promise<void> {
    try {
      await this.notificationService.sendSms(
        phoneNumber,
        'Zaroorat: Verification is temporarily locked after too many incorrect attempts. Please try again later.',
      );
    } catch (err) {
      logger.warn({ err }, '[OTP] failed to send lockout notification');
    }
  }

  private async recordOutcome(
    challengeId: string | undefined,
    outcome: OtpOutcome,
    options?: UpdateOutcomeOptions,
  ): Promise<void> {
    if (!challengeId) return;
    try {
      await this.otpRepository.updateOutcome(challengeId, outcome, options);
    } catch (err) {
      logger.warn({ err, challengeId }, '[OTP] failed to update audit trail');
    }
  }
}
