import { z } from 'zod';

import { userConfig } from '@config/user';
import type { ErrorDetail } from '../errors';

/**
 * Fields a user may never set through this module (doc 02 §2.2, USER-INV-5).
 *
 * These are rejected explicitly with `IMMUTABLE_FIELD` rather than stripped:
 * silently dropping a field the client believed it set is how bugs hide. The
 * list covers everything the invariant names — phone number, email, email
 * verification state, account status, and roles — plus the identifiers a caller
 * might use to try to address someone else's row.
 *
 * `isEmailVerified` is not in doc 02 §2.2's enumeration but is squarely inside
 * USER-INV-5's "email-verification state"; omitting it would leave a hole the
 * invariant forbids.
 */
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

/** A human name: letters, marks, spaces, hyphens, apostrophes (doc 02 §2.2). */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s'-]*$/u;

/** Calendar date, `YYYY-MM-DD` (doc 03 §3.1 — date-only, no instant). */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whole years elapsed between a birth date and now, by calendar arithmetic. */
function ageInYears(birth: Date, now: Date = new Date()): number {
  let years = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) years -= 1;
  return years;
}

/** Parse `YYYY-MM-DD` as a UTC midnight instant, or `null` if not a real date. */
export function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects overflow dates the Date constructor silently rolls over (2026-02-30).
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

/** A trimmed given/family name. */
const nameField = z.string().trim().min(1).max(64).regex(NAME_PATTERN, 'INVALID_FORMAT').nullable();

/**
 * `dateOfBirth` as a calendar date: real date, in the past, at or above the
 * configured minimum age. Each rule reports its own vocabulary code so the
 * client can highlight the field with the right copy (doc 04 §6).
 */
const dateOfBirthField = z
  .string()
  .refine((value) => parseDateOnly(value) !== null, 'INVALID_FORMAT')
  .refine((value) => {
    const parsed = parseDateOnly(value);
    return parsed === null || parsed.getTime() < Date.now();
  }, 'MUST_BE_PAST')
  .refine((value) => {
    const parsed = parseDateOnly(value);
    // A future date is already reported as MUST_BE_PAST. Letting the age rule
    // fire as well would answer one bad field with two codes and invite the
    // client to render "you are too young" at someone born in 2999.
    if (parsed === null || parsed.getTime() >= Date.now()) return true;
    return ageInYears(parsed) >= userConfig.minimumAgeYears;
  }, 'AGE_BELOW_MINIMUM')
  .nullable();

/**
 * The avatar, as a `files` id (files doc 03 §7.2).
 *
 * Shape only — a well-formed uuid. **Everything that matters is checked in the
 * service**, inside the transaction that writes the column: that the file
 * exists, belongs to this caller, is a `PROFILE_IMAGE`, and had its bytes
 * verified (R-FILE-27, FILE-INV-3). None of that is knowable from a string, and
 * a schema that pretended otherwise would be a check a client could route
 * around.
 */
const profileImageFileIdField = z.string().uuid().nullable();

/**
 * `PATCH /api/v1/users/me/profile` (doc 02 §2.2).
 *
 * Strict: an unknown key is an error, never a silent drop. Every field is
 * optional and nullable — an absent key leaves the column unchanged, an explicit
 * `null` clears it (R-USER-5).
 */
export const updateProfileSchema = z.strictObject({
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  dateOfBirth: dateOfBirthField.optional(),
  gender: z.enum(userConfig.genderValues).nullable().optional(),
  // `profileImage` is deliberately absent, not deprecated-but-accepted: this is
  // a strict object, so a client still sending the old URL field gets a
  // `VALIDATION` naming it rather than a silent drop that looks like success
  // (files doc 03 §7.2, deploy 3).
  profileImageFileId: profileImageFileIdField.optional(),
  languageCode: z
    .string()
    .refine((value) => userConfig.supportedLanguageCodes.includes(value), 'NOT_ALLOWED')
    .nullable()
    .optional(),
});

export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;

/**
 * E.164, matching AUTH's regex exactly (`auth/http/auth.schemas.ts`).
 *
 * Restated rather than imported because the two modules validate the same wire
 * format for different reasons, and a shared constant would make AUTH's login
 * format a dependency of USER's phone change. If they ever need to diverge, this
 * is the seam; until then a drift is caught by the integration suite, which
 * registers through AUTH and changes through USER.
 */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** `POST /api/v1/users/me/phone/change` (doc 02 §2.4.1). */
export const phoneChangeSchema = z.strictObject({
  newPhoneNumber: z.string().regex(E164_PATTERN, 'INVALID_FORMAT'),
});

/**
 * `POST /api/v1/users/me/phone/verify` (doc 02 §2.4.2).
 *
 * No phone number in the body, by design: the target is read from the challenge
 * AUTH recorded at step 1, so a code minted for one number can never be presented
 * against another.
 */
export const phoneVerifySchema = z.strictObject({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'INVALID_FORMAT'),
});

/**
 * Emergency contact, create shape (doc 02 §2.5).
 *
 * Strict, like every body in this module: an unknown key is an error, never a
 * silent drop.
 */
export const createContactSchema = z.strictObject({
  contactName: z.string().trim().min(1).max(64),
  phoneNumber: z.string().regex(E164_PATTERN, 'INVALID_FORMAT'),
  relationship: z.string().trim().max(32).nullable().optional(),
  priority: z.int().min(1).optional(),
});

/**
 * Emergency contact, partial edit (doc 02 §2.5).
 *
 * `contactName`, `phoneNumber`, and `priority` are settable but not nullable —
 * they are `NOT NULL` columns, so "clear it" has no meaning. `relationship` is
 * the only optional column and therefore the only clearable field.
 */
export const updateContactSchema = z.strictObject({
  contactName: z.string().trim().min(1).max(64).optional(),
  phoneNumber: z.string().regex(E164_PATTERN, 'INVALID_FORMAT').optional(),
  relationship: z.string().trim().max(32).nullable().optional(),
  priority: z.int().min(1).optional(),
});

/**
 * Everything on a saved place except the label — all optional, all clearable
 * (doc 02 §2.6). The coordinate bounds are the domain's, not the column's.
 */
const placeFields = {
  address: z.string().trim().max(255).nullable().optional(),
  buildingName: z.string().trim().max(120).nullable().optional(),
  landmark: z.string().trim().max(120).nullable().optional(),
  floor: z.string().trim().max(32).nullable().optional(),
  // Bounded because it reaches a driver's screen (doc 02 §2.6).
  instructions: z.string().trim().max(280).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
};

/**
 * Latitude and longitude are only meaningful together (doc 02 §2.6).
 *
 * A cross-field rule rather than two required fields, because a `PATCH` may
 * legitimately touch neither — and a place carrying one coordinate would derive a
 * `location` sitting on the equator or the prime meridian, silently.
 */
function bothOrNeither(body: object): boolean {
  if (Object.hasOwn(body, 'latitude') !== Object.hasOwn(body, 'longitude')) return false;
  const { latitude, longitude } = body as { latitude?: number | null; longitude?: number | null };
  // Clearing is also a pair: `{ latitude: null, longitude: 77.5 }` is a half-set
  // point, which is the same silent wrongness in the opposite direction.
  return (latitude === null) === (longitude === null);
}

/** Saved place, create shape (doc 02 §2.6). */
export const createPlaceSchema = z
  .strictObject({ label: z.string().trim().min(1).max(32), ...placeFields })
  .refine(bothOrNeither, { message: 'REQUIRED', path: ['longitude'] });

/** Saved place, partial edit (doc 02 §2.6). */
export const updatePlaceSchema = z
  .strictObject({ label: z.string().trim().min(1).max(32).optional(), ...placeFields })
  .refine(bothOrNeither, { message: 'REQUIRED', path: ['longitude'] });

export type CreateContactBody = z.infer<typeof createContactSchema>;
export type UpdateContactBody = z.infer<typeof updateContactSchema>;
export type CreatePlaceBody = z.infer<typeof createPlaceSchema>;
export type UpdatePlaceBody = z.infer<typeof updatePlaceSchema>;

/**
 * `POST /api/v1/users/me/deactivate` (doc 02 §2.7).
 *
 * The reason is optional and comes from a coarse enum. Free text is refused
 * because this value lands in an audit event, and free text is where a personal
 * value leaks into the event stream (doc 05 §3.3).
 */
export const deactivateSchema = z.strictObject({
  reason: z.enum(userConfig.deactivationReasons).optional(),
});

export type DeactivateBody = z.infer<typeof deactivateSchema>;

/** A path `:id` — a UUID, so a malformed one is a `VALIDATION`, not a `404`. */
export const itemIdSchema = z.uuid();

/** The stable `details[].code` vocabulary (doc 04 §6). */
const DETAIL_CODES = new Set([
  'REQUIRED',
  'INVALID_FORMAT',
  'TOO_LONG',
  'OUT_OF_RANGE',
  'MUST_BE_PAST',
  'AGE_BELOW_MINIMUM',
  'NOT_ALLOWED',
  'IMMUTABLE',
]);

/** Derive a vocabulary code from a Zod issue that did not name one itself. */
function codeForIssue(issue: z.core.$ZodIssue): string {
  const origin = (issue as { origin?: string }).origin;
  switch (issue.code) {
    case 'too_big':
      return origin === 'string' ? 'TOO_LONG' : 'OUT_OF_RANGE';
    case 'too_small':
      return origin === 'string' ? 'REQUIRED' : 'OUT_OF_RANGE';
    case 'invalid_value':
    case 'unrecognized_keys':
      return 'NOT_ALLOWED';
    default:
      return 'INVALID_FORMAT';
  }
}

/**
 * Map Zod issues to the doc 04 §6 `details` array.
 *
 * This exists because AUTH forwards `parsed.error.issues` verbatim and Zod
 * issues can carry the submitted input. USER's privacy rule is stricter (doc 04
 * §5): `details` carries `field` and `code` and nothing else, because error
 * bodies end up in crash reports and support screenshots. A refinement whose
 * message is already a vocabulary token passes straight through.
 *
 * @param issues Issues from a failed `safeParse`.
 * @returns Field-level details, free of any submitted value.
 */
export function detailsFromZodIssues(issues: readonly z.core.$ZodIssue[]): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) details.push({ field: key, code: 'NOT_ALLOWED' });
      continue;
    }
    const field = issue.path.length > 0 ? issue.path.join('.') : 'body';
    const code = DETAIL_CODES.has(issue.message) ? issue.message : codeForIssue(issue);
    details.push({ field, code });
  }
  return details;
}

/**
 * Find immutable fields present in a raw request body (doc 02 §2.2).
 * @param body The unparsed request body.
 * @returns The offending field names, in the order the list defines them.
 */
export function findImmutableFields(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  return IMMUTABLE_PROFILE_FIELDS.filter((field) => Object.hasOwn(body, field));
}
