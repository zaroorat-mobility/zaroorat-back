export const IDEMPOTENCY_OPERATIONS = Object.freeze({
  OTP_VERIFY: 'otp-verify',
  ADMIN_LOGIN: 'admin-login',
  TOKEN_REFRESH: 'token-refresh',
  PHONE_CHANGE_VERIFY: 'phone-change-verify',
  PAYMENT: 'payment',
  RIDE_REQUEST: 'ride-request',
} as const);
export type IdempotencyOperation =
  (typeof IDEMPOTENCY_OPERATIONS)[keyof typeof IDEMPOTENCY_OPERATIONS];
export const RedisKeys = {
  otp: (purpose: string, phone: string): string => `otp:${purpose}:${phone}`,
  otpAttempts: (purpose: string, phone: string): string => `otp:att:${purpose}:${phone}`,
  otpLock: (purpose: string, phone: string): string => `otp:lock:${purpose}:${phone}`,
  otpChallenge: (purpose: string, phone: string): string => `otp:challenge:${purpose}:${phone}`,
  epoch: (userId: string): string => `auth:epoch:${userId}`,
  sidRevoked: (sid: string): string => `auth:sid:revoked:${sid}`,
  rateLimit: (scope: string, id: string): string => `ratelimit:${scope}:${id}`,
  idempotency: (operation: IdempotencyOperation, key: string): string => `idem:${operation}:${key}`,
  lock: (resource: string): string => `lock:${resource}`,
  /// Where the outbox notification reconciliation stopped. Holds a timestamp and
  /// an outbox row id only — never event payload. Dry runs keep their own.
  notificationEventReconciliationCursor: (mode: 'on' | 'dry-run'): string =>
    mode === 'on'
      ? 'notification:event-reconciliation:cursor'
      : 'notification:event-reconciliation:cursor:dry-run',
  tripDistance: (driverId: string): string => `ride:distance:${driverId}`,
} as const;
export type RedisKeys = typeof RedisKeys;
