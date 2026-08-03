import { RedisService } from '@core/cache';
import { EventPublisher } from '@core/events';
import type { OtpPurpose } from '@core/database/types';
import type { OtpConfig } from '@config/otp/otp.config';
import { logger } from '@shared/logger/index.js';
import { NotificationService } from '@modules/notifications';
import { authEvent } from '../events';
import {
  OtpRepository,
  type OtpOutcome,
  type UpdateOutcomeOptions,
} from '../repositories/otp.repository';
import { OtpExpiredError, OtpInvalidError, OtpLockedError, RateLimitedError } from '../errors';
import { OtpGenerator } from './otp.generator';
import { OtpHasher } from './otp.hasher';
import { OtpValidator } from './otp.validator';
import { OtpRateLimiter } from './otp.rate-limiter';
import { OtpMetrics } from './otp.metrics';

/** Matches a canonical UUID in any version. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a value can be written to a `@db.Uuid` column without a syntax error. */
function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Inputs for requesting an OTP. */
export interface SendOtpInput {
  phoneNumber: string;
  purpose: OtpPurpose;
  userId?: string | null;
  /**
   * The **client-reported** device id, used to key the per-device send limit
   * (doc 02 §4.2). It is only written to the attempt trail when it happens to be
   * an internal `user_devices.id` — the trail column is a UUID reference, and at
   * send time no device is bound yet.
   */
  deviceId?: string | null;
  ip?: string | null;
  /** Fraud metadata captured on the audit trail (non-secret). */
  deviceFingerprint?: string | null;
  userAgent?: string | null;
}

/** Uniform send response (auth doc 04 §2.1). */
export interface SendOtpResult {
  challengeId: string;
  expiresInSec: number;
  resendAvailableInSec: number;
}

/** Inputs for verifying an OTP. */
export interface VerifyOtpInput {
  phoneNumber: string;
  purpose: OtpPurpose;
  code: string;
  challengeId?: string;
}

/**
 * Orchestrates OTP generation, delivery, and verification (auth doc 02 §4,
 * doc 04 §2.1–2.2).
 *
 * The plaintext code exists only in memory and the outbound SMS — it is hashed
 * into Redis, never persisted or logged. Sends are idempotent within the resend
 * cooldown; verification is atomic and single-use. Every lifecycle event emits a
 * metric and (for sends/failures) a non-secret audit row. This service verifies
 * the code only; account creation and session issuance belong to the auth
 * service (Phase 8).
 */
export class OtpService {
  /**
   * @param otpGenerator CSPRNG code generation.
   * @param otpHasher Keyed hashing.
   * @param otpValidator Format checks.
   * @param otpRateLimiter Send limits and verify lockout.
   * @param redisService OTP secret + challenge store.
   * @param otpRepository Non-secret attempt/audit trail.
   * @param notificationService SMS delivery.
   * @param otpMetrics Lifecycle metrics.
   * @param otpConfig TTL and policy.
   */
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

  /**
   * Generate, deliver, record, and store an OTP. Resends within the cooldown are
   * idempotent — the same challenge is returned without minting a new code.
   * @param input Phone, purpose, and optional user/device/ip + fraud metadata.
   * @returns The uniform challenge response.
   * @throws {RateLimitedError} When a per-phone/device/IP limit is hit.
   */
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
      // `deviceId` arrives here as the **client-reported** id (doc 04 §2.1's
      // `device.deviceId`, e.g. "a1b2c3"), which is what the rate limiter keys
      // on. The column is `@db.Uuid`, a reference to `user_devices.id` — an
      // internal id that does not exist yet at send time, because binding a
      // device happens on verify and looking one up here would be the account
      // probe R-AUTH-19 forbids. Persisting the client string put invalid syntax
      // into a uuid column and returned 500 for the documented request body.
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

  /**
   * Verify a submitted OTP (atomic, single-use).
   *
   * On success the code is consumed and the challenge cleared. On failure: an
   * **expired** challenge yields {@link OtpExpiredError} (prompt a resend) and
   * does not count toward lockout; a **wrong** code yields {@link OtpInvalidError}
   * and increments the lockout counter. A locked phone yields
   * {@link OtpLockedError}. Expiry is judged only from the challenge row the
   * client already holds, so no phone existence leaks (doc 05 §3.2–§4).
   * @param input Phone, purpose, code, and optional challenge id.
   * @returns Nothing on success; throws on any failure.
   * @throws {OtpLockedError} When the phone is locked out.
   * @throws {OtpExpiredError} When the held challenge has expired.
   * @throws {OtpInvalidError} When the code is wrong.
   */
  async verify(input: VerifyOtpInput): Promise<void> {
    const { phoneNumber, purpose } = input;

    if (await this.otpRateLimiter.isLocked(phoneNumber)) {
      throw new OtpLockedError(this.otpConfig.lockoutSeconds);
    }

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

  /** True when the client's challenge exists, is unverified, and has expired. */
  private async isExpiredChallenge(challengeId: string | undefined): Promise<boolean> {
    if (!challengeId) return false;
    const row = await this.otpRepository.findById(challengeId);
    return !!row && !row.verifiedAt && row.expiresAt.getTime() <= Date.now();
  }

  /** Best-effort security alert when a phone crosses the lockout threshold. */
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

  /** Best-effort audit-trail update; never blocks the security outcome. */
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
