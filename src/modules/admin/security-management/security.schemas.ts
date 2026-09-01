import { z } from 'zod';

export const listSessionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  userId: z.string().uuid().optional(),
  activeOnly: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});

export const sessionIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const forceLogoutBodySchema = z.object({
  userId: z.string().uuid().optional(),
});

export const listLoginHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  userId: z.string().uuid().optional(),
});

export const listSecurityEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  action: z
    .enum(['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'EXPORT', 'APPROVE', 'REJECT'])
    .optional(),
});

export const securityPolicySchema = z.object({
  sessionMaxConcurrent: z.number().int().min(1).max(20),
  sessionTtlHours: z.number().int().min(1).max(720),
  requireMfa: z.boolean(),
  ipAllowlistEnabled: z.boolean(),
  passwordMinLength: z.number().int().min(8).max(128),
});

export type SecurityPolicyDto = z.infer<typeof securityPolicySchema>;

export const updateSecurityPolicyBodySchema = securityPolicySchema.partial();
