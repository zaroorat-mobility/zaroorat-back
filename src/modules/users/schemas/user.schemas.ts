import { z } from 'zod';
export { IMMUTABLE_PROFILE_FIELDS } from '../constants';
export { parseDateOnly } from '../utils';

import { userConfig } from '../config';
import { E164_PATTERN, IMMUTABLE_PROFILE_FIELDS, NAME_PATTERN } from '../constants';
import type { ErrorDetail } from '../errors';
import { ageInYears, parseDateOnly } from '../utils';

const nameField = z.string().trim().min(1).max(64).regex(NAME_PATTERN, 'INVALID_FORMAT').nullable();

const dateOfBirthField = z
  .string()
  .refine((value) => parseDateOnly(value) !== null, 'INVALID_FORMAT')
  .refine((value) => {
    const parsed = parseDateOnly(value);
    return parsed === null || parsed.getTime() < Date.now();
  }, 'MUST_BE_PAST')
  .refine((value) => {
    const parsed = parseDateOnly(value);
    if (parsed === null || parsed.getTime() >= Date.now()) return true;
    return ageInYears(parsed) >= userConfig.minimumAgeYears;
  }, 'AGE_BELOW_MINIMUM')
  .nullable();

const profileImageFileIdField = z.string().uuid().nullable();

export const updateProfileSchema = z.strictObject({
  firstName: nameField.optional(),
  lastName: nameField.optional(),
  dateOfBirth: dateOfBirthField.optional(),
  gender: z.enum(userConfig.genderValues).nullable().optional(),
  profileImageFileId: profileImageFileIdField.optional(),
  languageCode: z
    .string()
    .refine((value) => userConfig.supportedLanguageCodes.includes(value), 'NOT_ALLOWED')
    .nullable()
    .optional(),
});

export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;

export const phoneChangeSchema = z.strictObject({
  newPhoneNumber: z.string().regex(E164_PATTERN, 'INVALID_FORMAT'),
});

export const phoneVerifySchema = z.strictObject({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'INVALID_FORMAT'),
});

export const createContactSchema = z.strictObject({
  contactName: z.string().trim().min(1).max(64),
  phoneNumber: z.string().regex(E164_PATTERN, 'INVALID_FORMAT'),
  relationship: z.string().trim().max(32).nullable().optional(),
  priority: z.number().int().min(1).optional(),
});

export const updateContactSchema = z.strictObject({
  contactName: z.string().trim().min(1).max(64).optional(),
  phoneNumber: z.string().regex(E164_PATTERN, 'INVALID_FORMAT').optional(),
  relationship: z.string().trim().max(32).nullable().optional(),
  priority: z.number().int().min(1).optional(),
});

const placeFields = {
  address: z.string().trim().max(255).nullable().optional(),
  buildingName: z.string().trim().max(120).nullable().optional(),
  landmark: z.string().trim().max(120).nullable().optional(),
  floor: z.string().trim().max(32).nullable().optional(),
  instructions: z.string().trim().max(280).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
};

function bothOrNeither(body: object): boolean {
  if (Object.hasOwn(body, 'latitude') !== Object.hasOwn(body, 'longitude')) return false;
  const { latitude, longitude } = body as { latitude?: number | null; longitude?: number | null };
  return (latitude === null) === (longitude === null);
}

export const createPlaceSchema = z
  .strictObject({ label: z.string().trim().min(1).max(32), ...placeFields })
  .refine(bothOrNeither, { message: 'REQUIRED', path: ['longitude'] });

export const updatePlaceSchema = z
  .strictObject({ label: z.string().trim().min(1).max(32).optional(), ...placeFields })
  .refine(bothOrNeither, { message: 'REQUIRED', path: ['longitude'] });

export type CreateContactBody = z.infer<typeof createContactSchema>;
export type UpdateContactBody = z.infer<typeof updateContactSchema>;
export type CreatePlaceBody = z.infer<typeof createPlaceSchema>;
export type UpdatePlaceBody = z.infer<typeof updatePlaceSchema>;

export const deactivateSchema = z.strictObject({
  reason: z.enum(userConfig.deactivationReasons).optional(),
});

export type DeactivateBody = z.infer<typeof deactivateSchema>;

export const itemIdSchema = z.string().uuid();

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

export function findImmutableFields(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  return IMMUTABLE_PROFILE_FIELDS.filter((field) => Object.hasOwn(body, field));
}
