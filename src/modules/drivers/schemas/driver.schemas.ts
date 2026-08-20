import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '@modules/geo';
export const updateDriverProfileSchema = z.object({
  fullLegalName: z.string().min(2).max(100).optional(),
  dateOfBirth: z.string().datetime().optional(),
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
