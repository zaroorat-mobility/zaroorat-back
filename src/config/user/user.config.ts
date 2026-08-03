/**
 * USER module policy (user doc 01 §11 USER-OD-6, doc 02 §2.2).
 *
 * Collection caps live here rather than in code because R-USER-26 requires them
 * to be configuration. The profile-image host allow-list is **fail-closed**: with
 * no hosts configured, every `profileImage` is rejected as `UNTRUSTED_HOST`. That
 * is deliberate — the `files` module that issues those URLs is deferred (doc 01
 * §2.3), so until it ships there is no host the platform can vouch for, and
 * accepting an arbitrary URL would let a profile embed a third-party tracker.
 */

/** Parse a comma-separated env list into a frozen, trimmed array. */
function list(value: string | undefined, fallback: string): readonly string[] {
  return Object.freeze(
    (value ?? fallback)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export const userConfig = Object.freeze({
  /** Minimum age enforced on `dateOfBirth` (doc 02 §2.2). */
  minimumAgeYears: Number(process.env.USER_MIN_AGE_YEARS ?? 16),
  /** Accepted `languageCode` values — BCP-47 primary subtags (R-USER-7). */
  supportedLanguageCodes: list(process.env.USER_SUPPORTED_LANGUAGES, 'en,hi'),
  /** Hosts a `profileImage` URL may point at. Empty ⇒ reject everything. */
  profileImageHosts: list(process.env.USER_PROFILE_IMAGE_HOSTS, ''),
  /** Accepted `gender` values (USER-OD-5 — validated at the edge, stored as text). */
  genderValues: Object.freeze(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const),
  /** Default language stamped on a profile created with no preference (doc 03 §3.1). */
  defaultLanguageCode: 'en',
  /** Max emergency contacts per user (R-USER-22; consumed from milestone 4). */
  maxEmergencyContacts: Number(process.env.USER_MAX_EMERGENCY_CONTACTS ?? 5),
  /** Max saved places per user (R-USER-24; consumed from milestone 4). */
  maxSavedPlaces: Number(process.env.USER_MAX_SAVED_PLACES ?? 20),
  /**
   * Phone-change requests allowed per account per window (R-USER-15).
   *
   * This is a **second, per-account** limit stacked on AUTH's per-phone/device/IP
   * OTP limiter. AUTH's limiter counts sends against the *target* number, so an
   * attacker holding one hijacked session could walk a whole range of fresh
   * numbers without ever tripping it. This one counts the caller.
   */
  phoneChangeRequestLimit: Number(process.env.USER_PHONE_CHANGE_LIMIT ?? 3),
  /** Window for {@link phoneChangeRequestLimit}, in seconds (default 24 h). */
  phoneChangeWindowSeconds: Number(process.env.USER_PHONE_CHANGE_WINDOW_SEC ?? 86_400),
  /**
   * Accepted `reason` values on deactivation (doc 05 §3.3).
   *
   * A coarse enum and never free text: the reason travels in an audit event, and
   * free text is where a personal value leaks into the event stream.
   */
  deactivationReasons: Object.freeze(['NOT_USING', 'PRIVACY', 'SWITCHING', 'OTHER'] as const),
  /**
   * Days between a deletion request and the erasure the retention job performs
   * (R-USER-18/19, R-DATA-1). Only used to compute the `scheduledFor` this module
   * reports and audits — nothing here erases anything.
   */
  deletionRetentionDays: Number(process.env.USER_DELETION_RETENTION_DAYS ?? 30),
});

export type UserConfig = typeof userConfig;
