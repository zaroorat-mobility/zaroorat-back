import { z } from 'zod';

export const listVehiclesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
});

export const vehicleIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const flagRenewalBodySchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export type ListVehiclesQuery = z.infer<typeof listVehiclesQuerySchema>;
export type FlagRenewalBody = z.infer<typeof flagRenewalBodySchema>;
