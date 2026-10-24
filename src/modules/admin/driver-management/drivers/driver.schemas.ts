import { z } from 'zod';

export const listDriversQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'active', 'suspended', 'blocked', 'pending', 'rejected', 'online', 'offline'])
    .optional()
    .default('all'),
});

export const driverIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const suspendDriverBodySchema = z.object({
  /// Kept for existing callers (e.g. authorization tests). Defaults to true on
  /// the dedicated suspend route; activate always forces false.
  isSuspended: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
});

export type ListDriversQuery = z.infer<typeof listDriversQuerySchema>;
export type SuspendDriverBody = z.infer<typeof suspendDriverBodySchema>;

/// Phase 1 bank-account verification gate.
export const bankAccountParamSchema = z.object({
  driverId: z.string().uuid(),
  accountId: z.string().uuid(),
});
export const bankAccountDriverParamSchema = z.object({ driverId: z.string().uuid() });
export const bankAccountReasonBodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const updateDriverBodySchema = z.object({
  // Personal Info
  driverName: z.string().trim().min(1).max(120).optional(),
  fullName: z.string().trim().min(1).max(120).optional(),
  mobileNumber: z.string().trim().max(30).optional(),
  email: z.string().trim().email().or(z.literal('')).optional(),
  dateOfBirth: z.string().trim().optional(),
  gender: z.string().trim().optional(),
  bloodGroup: z.string().trim().optional(),
  drivingExperience: z.union([z.string(), z.number()]).optional(),
  drivingExperienceYears: z.coerce.number().int().min(0).max(60).optional(),
  preferredLanguage: z.string().trim().max(10).optional(),
  language: z.string().trim().max(10).optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  addressLine1: z.string().trim().optional(),
  address: z.string().trim().optional(),
  alternatePhone: z.string().trim().optional(),

  // Emergency Contact
  emergencyContactName: z.string().trim().optional(),
  emergencyContactNumber: z.string().trim().optional(),
  emergencyContactRelationship: z.string().trim().optional(),
  emergencyContacts: z
    .array(
      z.object({
        name: z.string().trim().optional(),
        phoneNumber: z.string().trim().optional(),
        relationship: z.string().trim().optional(),
      }),
    )
    .optional(),

  // Vehicle Info
  vehicle: z
    .object({
      brand: z.string().trim().optional(),
      model: z.string().trim().optional(),
      category: z.string().trim().optional(),
      registrationNo: z.string().trim().optional(),
      color: z.string().trim().optional(),
      yearOfManufacture: z.union([z.string(), z.number()]).optional(),
      fuelType: z.string().trim().optional(),
      permitNo: z.string().trim().optional(),
    })
    .optional(),
  vehicleMake: z.string().trim().optional(),
  vehicleModel: z.string().trim().optional(),
  registrationPlate: z.string().trim().optional(),
  vehicleType: z.string().trim().optional(),
  vehicleColor: z.string().trim().optional(),
  manufacturingYear: z.union([z.string(), z.number()]).optional(),
  fuelType: z.string().trim().optional(),
  permitType: z.string().trim().optional(),

  // Status & Plan
  driverStatus: z.string().trim().optional(),
  paymentModel: z.string().trim().optional(),

  // Bank Info
  bankAccount: z
    .object({
      bankName: z.string().trim().optional(),
      accountHolderName: z.string().trim().optional(),
      accountNumber: z.string().trim().optional(),
      ifscCode: z.string().trim().optional(),
      upiId: z.string().trim().optional(),
    })
    .optional(),
  bankName: z.string().trim().optional(),
  accountHolderName: z.string().trim().optional(),
  accountNumber: z.string().trim().optional(),
  ifscCode: z.string().trim().optional(),
  upiId: z.string().trim().optional(),
});

export type UpdateDriverBody = z.infer<typeof updateDriverBodySchema>;
