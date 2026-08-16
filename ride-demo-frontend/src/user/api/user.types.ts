/**
 * Transcribed from the backend source:
 *   src/modules/users/schemas/user.responses.ts     (accountResponse, profileResponse)
 *   src/modules/users/services/profile/profile.service.ts  (toProfileView)
 *   src/config/user/user.config.ts                  (gender + language enums)
 *   prisma/schema/shared/enums.prisma               (UserStatus)
 *
 * Returned bare — no `{ data }` wrapper on this route.
 */

/** prisma `enum UserStatus`. */
export type UserStatus = 'UNVERIFIED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

/** `userConfig.genderValues`. */
export type Gender = 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY';

/**
 * Every key is always present: `toProfileView` maps a missing profile row to an
 * all-null object rather than returning null, so `profile` itself is never null.
 * `languageCode` falls back to `userConfig.defaultLanguageCode` ('en').
 */
export interface UserProfile {
  firstName: string | null;
  lastName: string | null;
  /** Calendar date `YYYY-MM-DD`, not a timestamp. */
  dateOfBirth: string | null;
  gender: Gender | null;
  /** File id; resolving it to a URL belongs to the files module. */
  profileImageFileId: string | null;
  languageCode: string | null;
  referralCode: string | null;
}

/**
 * PATCH /api/v1/users/me/profile — partial update, returns the updated
 * `UserProfile`. Validated by `z.strictObject`, so an unknown key is rejected
 * outright; identity fields (phoneNumber, email, status, roles, referralCode, …)
 * are refused earlier still with 400 IMMUTABLE_FIELD.
 *
 * `referralCode` is deliberately absent: it is immutable.
 */
export interface UpdateProfileRequest {
  /** 1–64 chars, letters/marks then letters, marks, spaces, apostrophes, hyphens. */
  firstName?: string | null;
  lastName?: string | null;
  /** `YYYY-MM-DD`, in the past, at least 16 years ago (userConfig.minimumAgeYears). */
  dateOfBirth?: string | null;
  gender?: Gender | null;
  /** Must be a uuid of a file owned by the caller. */
  profileImageFileId?: string | null;
  /** Must be one of the backend's supported codes (`en`, `hi` by default). */
  languageCode?: string | null;
}

/** GET /api/v1/users/me — the `accountResponse` schema. */
export interface User {
  id: string;
  phoneNumber: string;
  email: string | null;
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  /** Widened to string so an enum value added server-side cannot break the UI. */
  status: UserStatus | (string & {});
  /** Role slugs from the role table, not a fixed enum. A user may hold several. */
  roles: string[];
  /** ISO 8601 UTC. */
  createdAt: string;
  /** ISO 8601 UTC; null until the first login completes. */
  lastLoginAt: string | null;
  profile: UserProfile;
}
