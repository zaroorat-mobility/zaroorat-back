import { RedisService } from '@core/cache';
import type { OtpConfig } from '@config/otp/otp.config';

/** Send context whose axes are independently limited. */
export interface OtpSendContext {
  phoneNumber: string;
  deviceId?: string | null;
  ip?: string | null;
}

/** A rate-limit decision plus the wait hint on rejection. */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Result of recording a failed verification. */
export interface FailedAttemptResult {
  locked: boolean;
}

/**
 * Enforces the OTP abuse controls (auth doc 02 §4.2–4.3) over Redis.
 *
 * Send: a minimum resend interval plus three independent fixed-window axes
 * (per phone / device / IP) — the strictest applies. Verify: a lockout after a
 * threshold of failed attempts. Thresholds come from config; this class owns
 * only the enforcement mechanics.
 */
export class OtpRateLimiter {
  /**
   * @param redisService Rate-limit and OTP stores.
   * @param otpConfig Limits, windows, lockout, and resend interval.
   */
  constructor(
    private readonly redisService: RedisService,
    private readonly otpConfig: OtpConfig,
  ) {}

  /**
   * Decide whether an OTP send is permitted, recording the hit(s) on each
   * configured axis (per phone / device / IP); returns on the first violation.
   *
   * The resend cooldown is enforced separately by the service via idempotent
   * challenge reuse, so it is not re-checked here.
   * @param context Phone plus optional device/IP.
   * @returns Allowed, or blocked with `retryAfterSeconds`.
   */
  async checkSend(context: OtpSendContext): Promise<RateLimitDecision> {
    const { rateLimits } = this.otpConfig;
    const { phoneNumber, deviceId, ip } = context;

    const phone = await this.hit(rateLimits.perPhone, phoneNumber);
    if (!phone.allowed) return phone;

    if (deviceId) {
      const device = await this.hit(rateLimits.perDevice, deviceId);
      if (!device.allowed) return device;
    }

    if (ip) {
      const perIp = await this.hit(rateLimits.perIp, ip);
      if (!perIp.allowed) return perIp;
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Reject a verification if the phone is currently locked out.
   * @param phoneNumber E.164 phone number.
   * @returns `true` if locked.
   */
  async isLocked(phoneNumber: string): Promise<boolean> {
    return this.redisService.otp.isLocked(phoneNumber);
  }

  /**
   * Record a failed verification, locking the phone once the threshold is hit.
   * @param phoneNumber E.164 phone number.
   * @returns Whether the phone is now locked.
   */
  async registerFailedAttempt(phoneNumber: string): Promise<FailedAttemptResult> {
    const count = await this.redisService.otp.incrementAttempts(
      phoneNumber,
      this.otpConfig.lockoutSeconds,
    );
    if (count >= this.otpConfig.maxVerifyAttempts) {
      await this.redisService.otp.lock(phoneNumber, this.otpConfig.lockoutSeconds);
      return { locked: true };
    }
    return { locked: false };
  }

  /**
   * Clear the failed-attempt counter (after a successful verification).
   * @param phoneNumber E.164 phone number.
   */
  async clearAttempts(phoneNumber: string): Promise<void> {
    await this.redisService.otp.clearAttempts(phoneNumber);
  }

  private async hit(
    axis: { scope: string; limit: number; windowSeconds: number },
    id: string,
  ): Promise<RateLimitDecision> {
    const result = await this.redisService.rateLimit.hit(
      axis.scope,
      id,
      axis.limit,
      axis.windowSeconds,
    );
    return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
  }
}
