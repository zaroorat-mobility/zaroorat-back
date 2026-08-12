import { randomInt } from 'node:crypto';
import { RIDE_OTP_LENGTH } from '../constants/ride.constants.js';

export function generateRideOtp(): string {
  let code = '';
  for (let i = 0; i < RIDE_OTP_LENGTH; i += 1) {
    code += randomInt(0, 10).toString();
  }
  return code;
}

// Hashing deliberately lives in AUTH's `OtpHasher` (HMAC-SHA256 with a
