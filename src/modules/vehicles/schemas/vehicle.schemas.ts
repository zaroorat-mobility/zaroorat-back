import { z } from 'zod';
export const claimVehicleSchema = z.object({
  registrationNumber: z.string().min(3).max(20),
  vehicleTypeId: z.string().uuid(),
  make: z.string().max(50).optional(),
  model: z.string().max(50).optional(),
  color: z.string().max(30).optional(),
  seatingCapacity: z.number().int().positive().max(20).optional(),
});
export type ClaimVehicleBody = z.infer<typeof claimVehicleSchema>;
