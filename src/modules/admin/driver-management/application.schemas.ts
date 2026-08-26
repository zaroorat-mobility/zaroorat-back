import { z } from 'zod';

const optionalUrl = z.union([z.string().url(), z.literal('')]).optional();
const e164Phone = z
  .string()
  .trim()
  .min(10)
  .max(16)
  .regex(/^\+?[1-9]\d{1,14}$/, 'phone must be E.164 or national digits');

export const listApplicationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'pending_review', 'under_review', 'rejected', 'resubmission_required'])
    .optional()
    .default('all'),
});

export const applicationIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const applicationNotesBodySchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export const applicationDocumentParamSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
});

export const createManualApplicationBodySchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  mobileNumber: e164Phone,
  email: z.union([z.string().email(), z.literal('')]).optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']),
  dateOfBirth: z.string().min(1),
  preferredLanguage: z.string().trim().min(1).max(40).optional(),
  referralCode: z.string().trim().max(40).optional(),
  country: z.string().trim().min(1).max(80).default('India'),
  state: z.string().trim().min(1).max(80),
  city: z.string().trim().min(1).max(80),
  postcode: z.string().trim().min(3).max(20),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(120).optional(),
  emergencyContactName: z.string().trim().min(2).max(120).optional(),
  emergencyContactNumber: e164Phone.optional(),
  profilePhotoUrl: optionalUrl,
  aadhaarNumber: z.string().regex(/^\d{12}$/),
  aadhaarFrontUrl: optionalUrl,
  aadhaarBackUrl: optionalUrl,
  panNumber: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
  panUrl: optionalUrl,
  driverSelfieUrl: optionalUrl,
  vehicleType: z.enum(['cab', 'auto', 'bike', 'carpool']),
  vehicleCategory: z.string().trim().min(1).max(80).optional(),
  brand: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  color: z.string().trim().min(1).max(40),
  registrationNumber: z.string().trim().min(4).max(20),
  manufacturingYear: z.coerce
    .number()
    .int()
    .min(2000)
    .max(new Date().getFullYear() + 1),
  seatCapacity: z.coerce.number().int().min(1).max(20),
  licenseNo: z.string().trim().min(5).max(40),
  licenseIssueDate: z.string().min(1),
  licenseExpiry: z.string().min(1),
  licenseFrontUrl: optionalUrl,
  licenseBackUrl: optionalUrl,
  rcNumber: z.string().trim().min(5).max(40),
  rcUrl: optionalUrl,
  insuranceNo: z.string().trim().min(5).max(40),
  insuranceExpiry: z.string().min(1),
  insuranceUrl: optionalUrl,
  permitNo: z.string().trim().min(5).max(40),
  permitExpiry: z.string().min(1),
  permitUrl: optionalUrl,
  pollutionNo: z.string().trim().min(5).max(40),
  pollutionExpiry: z.string().min(1),
  pollutionUrl: optionalUrl,
  fitnessNo: z.string().trim().max(40).optional(),
  fitnessExpiry: z.string().optional(),
  fitnessUrl: optionalUrl,
  bankAccountName: z.string().trim().min(2).max(120),
  bankAccountNumber: z.string().trim().min(5).max(40),
  bankIfsc: z.string().trim().min(4).max(20),
  bankName: z.string().trim().min(2).max(120),
  upiId: z.string().trim().max(80).optional(),
  registrationAction: z
    .enum(['submit_for_review', 'approve_immediately'])
    .default('submit_for_review'),
});

export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;
export type CreateManualApplicationBody = z.infer<typeof createManualApplicationBodySchema>;
