import { RedisService } from '@core/cache';
import type { OtpPurpose } from '@core/database/types';
import type { OtpConfig } from '@config/otp/otp.config';
export interface OtpSendContext {
  deviceId?: string | null;
  ip?: string | null;
}
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}
export interface FailedAttemptResult {
  locked: boolean;
}
export class OtpRateLimiter {
  constructor(
    private readonly redisService: RedisService,
    private readonly otpConfig: OtpConfig,
  ) {}
  async checkSecondaryAxes(context: OtpSendContext): Promise<RateLimitDecision> {
    const { rateLimits } = this.otpConfig;
    const { deviceId, ip } = context;
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
  async isLocked(purpose: OtpPurpose, phoneNumber: string): Promise<boolean> {
    return this.redisService.otp.isLocked(purpose, phoneNumber);
  }
  async registerFailedAttempt(
    purpose: OtpPurpose,
    phoneNumber: string,
  ): Promise<FailedAttemptResult> {
    const count = await this.redisService.otp.incrementAttempts(
      purpose,
      phoneNumber,
      this.otpConfig.lockoutSeconds,
    );
    if (count >= this.otpConfig.maxVerifyAttempts) {
      await this.redisService.otp.lock(purpose, phoneNumber, this.otpConfig.lockoutSeconds);
      return { locked: true };
    }
    return { locked: false };
  }
  async clearAttempts(purpose: OtpPurpose, phoneNumber: string): Promise<void> {
    await this.redisService.otp.clearAttempts(purpose, phoneNumber);
  }
  private async hit(
    axis: {
      scope: string;
      limit: number;
      windowSeconds: number;
    },
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
