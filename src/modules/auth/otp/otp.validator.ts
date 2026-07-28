import type { OtpConfig } from '@config/otp/otp.config';

/**
 * Validates the shape of a submitted OTP code.
 *
 * A cheap, constant-shape check that rejects obviously malformed input (wrong
 * length / non-numeric) before any hashing or Redis work. It reports only format
 * validity — never whether a code is correct — so it leaks nothing.
 */
export class OtpValidator {
  private readonly pattern: RegExp;

  /** @param otpConfig Supplies the expected code length. */
  constructor(otpConfig: OtpConfig) {
    this.pattern = new RegExp(`^\\d{${otpConfig.codeLength}}$`);
  }

  /**
   * Check whether a code has the expected numeric format.
   * @param code The submitted code.
   * @returns `true` if it is exactly the configured number of digits.
   */
  isValidFormat(code: string): boolean {
    return this.pattern.test(code);
  }
}
