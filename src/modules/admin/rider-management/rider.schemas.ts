import { z } from 'zod';

export const riderStatusSchema = z.enum(['active', 'suspended', 'blocked']);

export const listRidersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .union([riderStatusSchema, z.literal('all')])
    .optional()
    .default('all'),
});

export const riderIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const riderStatusNotesBodySchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export type ListRidersQuery = z.infer<typeof listRidersQuerySchema>;
export type RiderStatusNotesBody = z.infer<typeof riderStatusNotesBodySchema>;
export type RiderStatusDto = z.infer<typeof riderStatusSchema>;
