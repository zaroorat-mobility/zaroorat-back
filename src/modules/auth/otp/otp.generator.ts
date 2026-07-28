import { randomInt } from 'node:crypto';
import type { OtpConfig } from '@config/otp/otp.config';

/**
 * Generates numeric OTP codes from a CSPRNG (auth doc 02 §4.1).
 *
 * Each digit is drawn with `crypto.randomInt` (uniform, no modulo bias), so
 * leading zeros are preserved and every code of the configured length is equally
 * likely.
 */
export class OtpGenerator {
  private readonly length: number;

  /** @param otpConfig Supplies the code length. */
  constructor(otpConfig: OtpConfig) {
    this.length = otpConfig.codeLength;
  }

  /**
   * Generate a fresh code.
   * @returns A numeric string of the configured length.
   */
  generate(): string {
    let code = '';
    for (let i = 0; i < this.length; i += 1) {
      code += randomInt(0, 10).toString();
    }
    return code;
  }
}
