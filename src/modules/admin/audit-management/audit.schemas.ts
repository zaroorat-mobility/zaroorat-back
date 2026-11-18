import { z } from 'zod';

export const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  actorId: z.string().uuid().optional(),
  entityType: z.string().optional(),
  entityTypes: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => {
      if (!val) return undefined;
      const list = Array.isArray(val) ? val : val.split(',');
      const cleaned = list.map((s) => s.trim()).filter(Boolean);
      return cleaned.length > 0 ? cleaned : undefined;
    }),
  entityId: z.string().uuid().optional(),
  action: z
    .enum(['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'APPROVE', 'REJECT'])
    .optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  search: z.string().trim().max(120).optional(),
});
