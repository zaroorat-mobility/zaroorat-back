import { createHmac } from 'node:crypto';
import type { OtpConfig } from '@config/otp/otp.config';

/**
 * Hashes OTP codes with a keyed HMAC (auth doc 02 §4.1).
 *
 * The plaintext code is never stored; only this digest is written to Redis. The
 * same digest is recomputed for a presented code and compared atomically by the
 * OTP store. A keyed hash (not bcrypt) is correct here — brute force is bounded
 * by the 5-attempt lockout and 5-minute TTL, so verify latency must stay low.
 */
export class OtpHasher {
  private readonly pepper: string;

  /** @param otpConfig Supplies the HMAC pepper. */
  constructor(otpConfig: OtpConfig) {
    this.pepper = otpConfig.pepper;
  }

  /**
   * Compute the stored digest for a code.
   * @param code The plaintext OTP.
   * @returns The hex HMAC-SHA256 digest.
   */
  hash(code: string): string {
    return createHmac('sha256', this.pepper).update(code).digest('hex');
  }
}
