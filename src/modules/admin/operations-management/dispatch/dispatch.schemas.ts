import { z } from 'zod';

export const listDispatchRequestsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z
    .enum(['all', 'CREATED', 'SEARCHING', 'MATCHED', 'EXPIRED', 'ABANDONED'])
    .optional()
    .default('all'),
  vehicleTypeId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
});

export type ListDispatchRequestsQuery = z.infer<typeof listDispatchRequestsQuerySchema>;

export const dispatchRequestIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type DispatchRequestIdParam = z.infer<typeof dispatchRequestIdParamSchema>;
