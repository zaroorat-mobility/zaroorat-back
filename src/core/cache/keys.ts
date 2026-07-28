/**
 * Central catalog of Redis key builders — the single source of truth for key
 * naming, matching the Redis Key Catalog (docs/06_Database/04_redis-keys.md) and
 * the auth security spec (docs/auth/02 §3.3, §4). Keys follow the
 * `domain:entity:qualifier` convention. TTL policy is the caller's concern; this
 * module fixes only structure.
 */
export const RedisKeys = {
  /** Hashed OTP secret for a phone+purpose. Value: HMAC-SHA256(code, pepper). */
  otp: (purpose: string, phone: string): string => `otp:${purpose}:${phone}`,
  /** OTP verify-attempt counter for a phone (lockout accounting). */
  otpAttempts: (phone: string): string => `otp:att:${phone}`,
  /** OTP lockout marker for a phone. */
  otpLock: (phone: string): string => `otp:lock:${phone}`,
  /** Active-challenge metadata for idempotent resend (short TTL = resend window). */
  otpChallenge: (purpose: string, phone: string): string => `otp:challenge:${purpose}:${phone}`,

  /** Per-user session epoch — the fast-revocation authority. */
  epoch: (userId: string): string => `auth:epoch:${userId}`,

  /** Per-session revocation marker (short-TTL denylist entry). */
  sidRevoked: (sid: string): string => `auth:sid:revoked:${sid}`,

  /** Generic rate-limit counter, e.g. `ratelimit:otp:req:{phone}`. */
  rateLimit: (scope: string, id: string): string => `ratelimit:${scope}:${id}`,

  /** Stored idempotent response for a client-supplied key. */
  idempotency: (key: string): string => `idem:${key}`,

  /** Distributed lock over a named resource. */
  lock: (resource: string): string => `lock:${resource}`,
} as const;

export type RedisKeys = typeof RedisKeys;
