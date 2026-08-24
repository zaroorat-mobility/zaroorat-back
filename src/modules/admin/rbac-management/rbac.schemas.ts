import { z } from 'zod';

export const rbacRoleSlugParamSchema = z.object({
  slug: z.string().min(1).max(64),
});

export const replaceRolePermissionsBodySchema = z.object({
  permissionCodes: z.array(z.string().min(1).max(80)).max(200),
});

export const createRoleBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240).optional(),
  permissionCodes: z.array(z.string().min(1).max(80)).max(200).optional(),
});

export type ReplaceRolePermissionsBody = z.infer<typeof replaceRolePermissionsBodySchema>;
export type CreateRoleBody = z.infer<typeof createRoleBodySchema>;
