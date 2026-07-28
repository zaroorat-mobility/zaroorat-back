import { createHmac } from 'node:crypto';
import { validatedEnv } from '../env/validated-env.js';

/**
 * Resolve the OTP hashing pepper.
 *
 * Prefers an explicit `OTP_PEPPER` (secret store). Otherwise derives a distinct
 * pepper from the refresh secret via domain separation, so OTP hashing never
 * shares key material with refresh-token hashing while avoiding a new required
 * environment variable (doc 02 §4.1 / §3.4).
 */
function resolvePepper(): string {
  const explicit = process.env.OTP_PEPPER;
  if (explicit) return explicit;
  return createHmac('sha256', validatedEnv.JWT_REFRESH_SECRET)
    .update('zaroorat:otp:pepper:v1')
    .digest('hex');
}

/**
 * OTP policy — codes, TTL, lockout, resend interval, and the three send
 * rate-limit axes (auth doc 02 §4.1–4.3). These are deterministic controls; the
 * OTP module reads them, it does not hardcode thresholds.
 */
export const otpConfig = Object.freeze({
  codeLength: 6,
  ttlSeconds: 300,
  maxVerifyAttempts: 5,
  lockoutSeconds: 900,
  resendIntervalSeconds: 60,
  rateLimits: {
    perPhone: { scope: 'otp:req', limit: 3, windowSeconds: 3600 },
    perDevice: { scope: 'otp:dev', limit: 5, windowSeconds: 3600 },
    perIp: { scope: 'otp:ip', limit: 20, windowSeconds: 3600 },
  },
  pepper: resolvePepper(),
});

export type OtpConfig = typeof otpConfig;
