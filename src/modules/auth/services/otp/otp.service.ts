import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import type { OtpPurpose } from '@core/database/types';
import type { OtpConfig } from '@config/otp/otp.config';
import { logger } from '@shared/logger/index.js';
import { uuidV7 } from '@shared/crypto';
import { NotificationService } from '@modules/notifications';
import type { OtpDeliveryJobData } from '@/jobs/producers/index.js';
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
export interface OtpDeliveryProducer {
  enqueue(data: OtpDeliveryJobData): Promise<void>;
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
    private readonly otpProducer: OtpDeliveryProducer,
  ) {}
  async send(input: SendOtpInput): Promise<SendOtpResult> {
    const { phoneNumber, purpose } = input;
    const challengeId = uuidV7();
    const otpExpiresAt = Date.now() + this.otpConfig.ttlSeconds * 1000;
    const claim = await this.redisService.otp.claimChallenge(
      purpose,
      phoneNumber,
      { challengeId, otpExpiresAt },
      {
        cooldownSeconds: this.otpConfig.resendIntervalSeconds,
        rateLimitScope: this.otpConfig.rateLimits.perPhone.scope,
        limit: this.otpConfig.rateLimits.perPhone.limit,
        windowSeconds: this.otpConfig.rateLimits.perPhone.windowSeconds,
      },
    );
    if (claim.status === 'active') {
      return {
        challengeId: claim.challenge.challengeId,
        expiresInSec: Math.max(0, Math.ceil((claim.challenge.otpExpiresAt - Date.now()) / 1000)),
        resendAvailableInSec: claim.challenge.resendTtlSeconds,
      };
    }
    if (claim.status === 'rate_limited') {
      this.otpMetrics.rateLimited({ purpose });
      throw new RateLimitedError(claim.retryAfterSeconds);
    }
    const release = (): Promise<boolean> =>
      this.redisService.otp.releaseChallenge(purpose, phoneNumber, claim.payload);
    const secondary = await this.otpRateLimiter.checkSecondaryAxes({
      deviceId: input.deviceId ?? null,
      ip: input.ip ?? null,
    });
    if (!secondary.allowed) {
      await release();
      this.otpMetrics.rateLimited({ purpose });
      throw new RateLimitedError(secondary.retryAfterSeconds);
    }
    try {
      const code = this.otpGenerator.generate();
      logger.debug({ otp: code, phoneNumber, purpose }, '[OTP] generated');
      await this.redisService.otp.store(
        purpose,
        phoneNumber,
        this.otpHasher.hash(code),
        this.otpConfig.ttlSeconds,
      );
      await this.eventPublisher.publish(
        authEvent('auth.otp.requested', { data: { phoneNumber, purpose } }),
      );
      await this.otpRepository.create({
        id: challengeId,
        phoneNumber,
        purpose,
        outcome: 'queued',
        expiresAt: new Date(otpExpiresAt),
        ...(input.userId != null ? { userId: input.userId } : {}),
        ...(isUuid(input.deviceId) ? { deviceId: input.deviceId } : {}),
        ...(input.ip != null ? { ipAddress: input.ip } : {}),
        ...(input.deviceFingerprint != null ? { deviceFingerprint: input.deviceFingerprint } : {}),
        ...(input.userAgent != null ? { userAgent: input.userAgent } : {}),
      });
      await this.otpProducer.enqueue({ challengeId, phoneNumber, code, purpose });
    } catch (err) {
      await release();
      await this.redisService.otp.clearSecret(purpose, phoneNumber);
      throw err;
    }
    this.otpMetrics.queued({ purpose });
    return {
      challengeId,
      expiresInSec: this.otpConfig.ttlSeconds,
      resendAvailableInSec: this.otpConfig.resendIntervalSeconds,
    };
  }
  async verify(input: VerifyOtpInput): Promise<void> {
    const { phoneNumber, purpose } = input;
    if (await this.otpRateLimiter.isLocked(purpose, phoneNumber)) {
      throw new OtpLockedError(this.otpConfig.lockoutSeconds);
    }
    await this.assertChallengeBelongsToCaller(input);
    const matched =
      this.otpValidator.isValidFormat(input.code) &&
      (await this.redisService.otp.consume(purpose, phoneNumber, this.otpHasher.hash(input.code)));
    if (matched) {
      await this.otpRateLimiter.clearAttempts(purpose, phoneNumber);
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
    const { locked } = await this.otpRateLimiter.registerFailedAttempt(purpose, phoneNumber);
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
    const { locked } = await this.otpRateLimiter.registerFailedAttempt(
      input.purpose,
      input.phoneNumber,
    );
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
