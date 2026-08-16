import { randomInt } from 'node:crypto';
import type { OtpConfig } from '@config/otp/otp.config';
export class OtpGenerator {
  private readonly length: number;
  constructor(otpConfig: OtpConfig) {
    this.length = otpConfig.codeLength;
  }
  generate(): string {
    let code = '';
    for (let i = 0; i < this.length; i += 1) {
      code += randomInt(0, 10).toString();
    }
    return code;
  }
}
