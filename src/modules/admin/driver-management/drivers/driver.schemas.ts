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
