import type { OtpConfig } from '@config/otp/otp.config';

export class OtpValidator {
  private readonly pattern: RegExp;

  constructor(otpConfig: OtpConfig) {
    this.pattern = new RegExp(`^\\d{${otpConfig.codeLength}}$`);
  }

  isValidFormat(code: string): boolean {
    return this.pattern.test(code);
  }
}
