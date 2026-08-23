import type { RateLimitOptions } from '../../plugins/rate-limit/rate-limit.plugin.js';
export const rateLimits = Object.freeze({
  otpVerify: Object.freeze<RateLimitOptions>({
    scope: 'rl:otp-verify',
    limit: Number(process.env.RL_OTP_VERIFY_LIMIT ?? 10),
    windowSeconds: Number(process.env.RL_OTP_VERIFY_WINDOW ?? 900),
    keyBy: 'ip',
  }),
  otpSend: Object.freeze<RateLimitOptions>({
    scope: 'rl:otp-send',
    limit: Number(process.env.RL_OTP_SEND_LIMIT ?? 20),
    windowSeconds: Number(process.env.RL_OTP_SEND_WINDOW ?? 3600),
    keyBy: 'ip',
  }),
  tokenRefresh: Object.freeze<RateLimitOptions>({
    scope: 'rl:token-refresh',
    limit: Number(process.env.RL_REFRESH_LIMIT ?? 30),
    windowSeconds: Number(process.env.RL_REFRESH_WINDOW ?? 900),
    keyBy: 'ip',
  }),
  fileUpload: Object.freeze<RateLimitOptions>({
    scope: 'rl:file-upload',
    limit: Number(process.env.RL_FILE_UPLOAD_LIMIT ?? 30),
    windowSeconds: Number(process.env.RL_FILE_UPLOAD_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  payment: Object.freeze<RateLimitOptions>({
    scope: 'rl:payment',
    limit: Number(process.env.RL_PAYMENT_LIMIT ?? 20),
    windowSeconds: Number(process.env.RL_PAYMENT_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  webhook: Object.freeze<RateLimitOptions>({
    scope: 'rl:webhook',
    limit: Number(process.env.RL_WEBHOOK_LIMIT ?? 600),
    windowSeconds: Number(process.env.RL_WEBHOOK_WINDOW ?? 60),
    keyBy: 'ip',
    onStoreError: 'open',
  }),
  rideWrite: Object.freeze<RateLimitOptions>({
    scope: 'rl:ride-write',
    limit: Number(process.env.RL_RIDE_WRITE_LIMIT ?? 60),
    windowSeconds: Number(process.env.RL_RIDE_WRITE_WINDOW ?? 3600),
    keyBy: 'user',
  }),
  driverLocation: Object.freeze<RateLimitOptions>({
    scope: 'rl:driver-location',
    limit: Number(process.env.RL_DRIVER_LOCATION_LIMIT ?? 120),
    windowSeconds: Number(process.env.RL_DRIVER_LOCATION_WINDOW ?? 60),
    keyBy: 'user',
  }),
  adminLogin: Object.freeze<RateLimitOptions>({
    scope: 'rl:admin-login',
    limit: Number(process.env.RL_ADMIN_LOGIN_LIMIT ?? 10),
    windowSeconds: Number(process.env.RL_ADMIN_LOGIN_WINDOW ?? 900),
    keyBy: 'ip',
  }),
});
export type RateLimits = typeof rateLimits;
