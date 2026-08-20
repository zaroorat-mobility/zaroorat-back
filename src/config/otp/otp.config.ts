import { createHmac } from 'node:crypto';
import { validatedEnv } from '../env/validated-env.js';
function resolvePepper(): string {
  const explicit = process.env.OTP_PEPPER;
  if (explicit) return explicit;
  return createHmac('sha256', validatedEnv.JWT_REFRESH_SECRET)
    .update('zaroorat:otp:pepper:v1')
    .digest('hex');
}
export const otpConfig = Object.freeze({
  codeLength: Number(process.env.OTP_CODE_LENGTH ?? 6),
  ttlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 300),
  maxVerifyAttempts: Number(process.env.OTP_MAX_VERIFY_ATTEMPTS ?? 5),
  lockoutSeconds: Number(process.env.OTP_LOCKOUT_SECONDS ?? 900),
  resendIntervalSeconds: Number(process.env.OTP_RESEND_INTERVAL_SECONDS ?? 60),
  trailRetentionDays: Number(process.env.OTP_TRAIL_RETENTION_DAYS ?? 30),
  delivery: {
    attempts: Number(process.env.OTP_DELIVERY_ATTEMPTS ?? 3),
    backoffMs: Number(process.env.OTP_DELIVERY_BACKOFF_MS ?? 2000),
  },
  rateLimits: {
    perPhone: {
      scope: 'otp:req',
      limit: Number(process.env.OTP_LIMIT_PHONE ?? 3),
      windowSeconds: Number(process.env.OTP_WINDOW_PHONE ?? 3600),
    },
    perDevice: {
      scope: 'otp:dev',
      limit: Number(process.env.OTP_LIMIT_DEVICE ?? 5),
      windowSeconds: Number(process.env.OTP_WINDOW_DEVICE ?? 3600),
    },
    perIp: {
      scope: 'otp:ip',
      limit: Number(process.env.OTP_LIMIT_IP ?? 20),
      windowSeconds: Number(process.env.OTP_WINDOW_IP ?? 3600),
    },
  },
  pepper: resolvePepper(),
});
export type OtpConfig = typeof otpConfig;
