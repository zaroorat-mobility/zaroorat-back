export const AUTH_OTP_PURPOSE = 'LOGIN' as const;
export const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS ?? 86_400);
export const DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer';
