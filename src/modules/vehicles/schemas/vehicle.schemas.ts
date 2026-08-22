import { z } from 'zod';
import { VEHICLE_DOCUMENT_TYPES } from '@config';

export const claimVehicleSchema = z.object({
  registrationNumber: z.string().min(3).max(20),
  vehicleTypeId: z.string().uuid(),
  make: z.string().max(50).optional(),
  model: z.string().max(50).optional(),
  color: z.string().max(30).optional(),
  seatingCapacity: z.number().int().positive().max(20).optional(),
});
export type ClaimVehicleBody = z.infer<typeof claimVehicleSchema>;

/// Registration number and vehicle type are deliberately absent: both are what
/// an operator reviewed and what ride acceptance matches against, so changing
/// either goes through `POST /vehicles/me/claim`, not a partial update.
export const updateVehicleSchema = z
  .object({
    make: z.string().max(50).optional(),
    model: z.string().max(50).optional(),
    color: z.string().max(30).optional(),
    seatingCapacity: z.number().int().positive().max(20).optional(),
    registrationState: z.string().max(50).optional(),
    fuelType: z.string().max(30).optional(),
    manufacturingYear: z
      .number()
      .int()
      .min(1900)
      .max(new Date().getFullYear() + 1)
      .optional(),
  })
  .strict();
export type UpdateVehicleBody = z.infer<typeof updateVehicleSchema>;

const documentTypeSchema = z.enum(VEHICLE_DOCUMENT_TYPES as unknown as [string, ...string[]]);

export const submitVehicleDocumentSchema = z.object({
  documentType: documentTypeSchema,
  fileId: z.string().uuid(),
  documentNumber: z.string().max(60).optional(),
  issuedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});
export type SubmitVehicleDocumentBody = z.infer<typeof submitVehicleDocumentSchema>;

export const reviewVehicleSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
  rejectionReason: z.string().max(255).optional(),
});
export type ReviewVehicleBody = z.infer<typeof reviewVehicleSchema>;
