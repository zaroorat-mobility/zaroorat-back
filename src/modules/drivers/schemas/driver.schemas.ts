import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '@modules/location';
export function validateDriverDob(
  val: string,
  now: Date = new Date(),
): {
  valid: boolean;
  code?: 'INVALID_FORMAT' | 'INVALID_CALENDAR_DATE' | 'MUST_BE_PAST' | 'AGE_BELOW_MINIMUM';
  message?: string;
  parsedDate?: Date;
} {
  const match = val.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (!match) {
    return {
      valid: false,
      code: 'INVALID_FORMAT',
      message: 'Date of birth must be in YYYY-MM-DD format',
    };
  }

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { valid: false, code: 'INVALID_FORMAT', message: 'Invalid calendar month or day' };
  }

  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]!) {
    return {
      valid: false,
      code: 'INVALID_CALENDAR_DATE',
      message: 'Date does not exist in calendar',
    };
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime())) {
    return { valid: false, code: 'INVALID_FORMAT', message: 'Invalid date' };
  }

  const nowUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999),
  );
  if (date.getTime() > nowUtc.getTime()) {
    return { valid: false, code: 'MUST_BE_PAST', message: 'Date of birth must be in the past' };
  }

  let age = now.getUTCFullYear() - year;
  const monthDiff = now.getUTCMonth() - (month - 1);
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < day)) {
    age--;
  }

  if (age < 18) {
    return {
      valid: false,
      code: 'AGE_BELOW_MINIMUM',
      message: 'Driver must be at least 18 years old',
    };
  }

  return { valid: true, parsedDate: date };
}

export const driverDobSchema = z.string().superRefine((val, ctx) => {
  const result = validateDriverDob(val);
  if (!result.valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.message || 'Driver must be at least 18 years old',
      params: { code: result.code },
    });
  }
});

export const updateDriverProfileSchema = z.object({
  fullLegalName: z.string().min(2).max(100).optional(),
  dateOfBirth: driverDobSchema.optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  addressLine: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  preferredLanguage: z.string().max(10).optional(),
  bloodGroup: z.string().max(10).optional(),
  alternatePhone: z.string().max(20).optional(),
  drivingExperienceYears: z.number().int().nonnegative().optional(),
  email: z.string().email().max(100).nullable().optional(),
});
export type UpdateDriverProfileBody = z.infer<typeof updateDriverProfileSchema>;
export const submitDriverDocumentSchema = z.object({
  documentType: z.enum([
    'DRIVING_LICENSE',
    'RC',
    'INSURANCE',
    'AADHAAR',
    'PAN',
    'PUC',
    'POLICE_VERIFICATION',
    'PROFILE_PHOTO',
  ]),
  fileId: z.string().uuid(),
  documentNumber: z.string().max(100).optional(),
  expiresAt: z.string().datetime().optional(),
});
export type SubmitDriverDocumentBody = z.infer<typeof submitDriverDocumentSchema>;
export const reviewDriverDocumentSchema = z
  .object({
    status: z.enum(['VERIFIED', 'REJECTED']),
    rejectionReason: z.string().min(1).max(255).optional(),
  })
  .refine((v) => v.status !== 'REJECTED' || !!v.rejectionReason, {
    message: 'rejectionReason is required when rejecting',
    path: ['rejectionReason'],
  });
export type ReviewDriverDocumentBody = z.infer<typeof reviewDriverDocumentSchema>;
export const updateLocationSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  heading: z.number().min(0).max(360).optional(),
  bearing: z.number().min(0).max(360).optional(),
  speedKmh: z.number().nonnegative().optional(),
  accuracyMeters: z.number().nonnegative().optional(),
  isMockLocation: z.boolean().optional(),
  rideId: z.string().uuid().optional(),
});
export type UpdateLocationBody = z.infer<typeof updateLocationSchema>;
export const heartbeatSchema = z.object({
  batteryLevel: z.number().int().min(0).max(100).optional(),
  networkType: z.string().max(50).optional(),
});
export type HeartbeatBody = z.infer<typeof heartbeatSchema>;
export const reviewVerificationSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
  rejectionReason: z.string().max(255).optional(),
});
export type ReviewVerificationBody = z.infer<typeof reviewVerificationSchema>;
/// 004-driver-subscription-wallet. plan.md "Driver Payment Model Selection &
/// Switching" — the only two models a driver may select between.
export const selectPaymentModelSchema = z.object({
  model: z.enum(['SUBSCRIPTION', 'COMMISSION']),
});
export type SelectPaymentModelBody = z.infer<typeof selectPaymentModelSchema>;
