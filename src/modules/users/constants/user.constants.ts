export const PHONE_CHANGE_PURPOSE = 'PHONE_CHANGE' as const;
export const RATE_LIMIT_SCOPE = 'user:phone_change';
export const REVOKE_REASON = 'phone_changed';
export const IDEMPOTENCY_TTL_SECONDS = 86400;
export const IMMUTABLE_PROFILE_FIELDS = Object.freeze([
  'id',
  'userId',
  'phoneNumber',
  'email',
  'isPhoneVerified',
  'isEmailVerified',
  'status',
  'roles',
  'referralCode',
]);
export const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s'-]*$/u;
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export { E164_PATTERN } from '@shared/validation';
export const ERASURE_LOCK = 'user:erasure';
export const ERASURE_LOCK_TTL_MS = 15 * 60 * 1000;
