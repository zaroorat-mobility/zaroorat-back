import { createHmac } from 'node:crypto';
import type { OtpConfig } from '@config/otp/otp.config';

export class OtpHasher {
  private readonly pepper: string;

  constructor(otpConfig: OtpConfig) {
    this.pepper = otpConfig.pepper;
  }

  hash(code: string): string {
    return createHmac('sha256', this.pepper).update(code).digest('hex');
  }
}
