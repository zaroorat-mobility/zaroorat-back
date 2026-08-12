export const RedisKeys = {
  otp: (purpose: string, phone: string): string => `otp:${purpose}:${phone}`,
  otpAttempts: (phone: string): string => `otp:att:${phone}`,
  otpLock: (phone: string): string => `otp:lock:${phone}`,
  otpChallenge: (purpose: string, phone: string): string => `otp:challenge:${purpose}:${phone}`,

  epoch: (userId: string): string => `auth:epoch:${userId}`,

  sidRevoked: (sid: string): string => `auth:sid:revoked:${sid}`,

  rateLimit: (scope: string, id: string): string => `ratelimit:${scope}:${id}`,

  idempotency: (key: string): string => `idem:${key}`,

  lock: (resource: string): string => `lock:${resource}`,
} as const;

export type RedisKeys = typeof RedisKeys;
