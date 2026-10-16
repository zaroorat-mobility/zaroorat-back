import { z } from 'zod';

export const listAvailablePromotionsQuerySchema = z.object({
  cityCode: z.string().trim().optional(),
  vehicleTypeId: z.string().uuid().optional(),
  subtotal: z.coerce.number().min(0).optional(),
});

export type ListAvailablePromotionsQuery = z.infer<typeof listAvailablePromotionsQuerySchema>;
