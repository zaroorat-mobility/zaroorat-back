import { z } from 'zod';
import { E164_PATTERN } from '@shared/validation/phone.js';

export const staffRoleSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'role must be a lowercase slug');

export const createStaffBodySchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional().default(''),
  email: z
    .string()
    .email()
    .max(100)
    .transform((value) => value.trim().toLowerCase()),
  phoneNumber: z.string().regex(E164_PATTERN, 'phoneNumber must be E.164'),
  password: z.string().min(8).max(128),
  role: staffRoleSchema,
});

export const updateStaffBodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    email: z
      .string()
      .email()
      .max(100)
      .transform((value) => value.trim().toLowerCase())
      .optional(),
    phoneNumber: z.string().regex(E164_PATTERN, 'phoneNumber must be E.164').optional(),
    password: z.string().min(8).max(128).optional(),
    role: staffRoleSchema.optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'At least one field must be provided',
  });

export const listStaffQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
});

export const staffIdParamSchema = z.object({
  id: z.string().min(1),
});

export type CreateStaffBody = z.infer<typeof createStaffBodySchema>;
export type UpdateStaffBody = z.infer<typeof updateStaffBodySchema>;
export type ListStaffQuery = z.infer<typeof listStaffQuerySchema>;
