export const AUTH_OTP_PURPOSE = 'LOGIN' as const;
export const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS ?? 86400);
/// Roles seeded as "provisioned out-of-band" (prisma/seed/shared/roles.ts) —
/// nobody should receive one of these just by logging in. `ensureDefaultRole`
/// grants DEFAULT_ROLE_SLUG to every login unconditionally, so a misconfigured
/// DEFAULT_USER_ROLE env var pointed at one of these would silently hand every
/// user staff-level access. Fail loudly at import time instead.
const PRIVILEGED_ROLE_SLUGS = new Set(['admin', 'support', 'finance']);
export const DEFAULT_ROLE_SLUG = process.env.DEFAULT_USER_ROLE ?? 'customer';
if (PRIVILEGED_ROLE_SLUGS.has(DEFAULT_ROLE_SLUG)) {
  throw new Error(
    `DEFAULT_USER_ROLE is set to "${DEFAULT_ROLE_SLUG}", a privileged role that must be ` +
      'provisioned out-of-band, not granted to every login. Refusing to start.',
  );
}
