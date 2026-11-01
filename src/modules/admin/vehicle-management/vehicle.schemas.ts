import { z } from 'zod';

export const listVehiclesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
});

export const vehicleIdParamSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

export const flagRenewalBodySchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export const createVehicleTypeBodySchema = z.object({
  code: z.string().trim().min(2).max(50),
  name: z.string().trim().min(2).max(100),
  category: z.string().trim().optional().default('car'),
  hasAc: z.boolean().default(false),
  badge: z
    .string()
    .trim()
    .max(30)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  description: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  imageUrl: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  imageFileId: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  icon: z
    .string()
    .trim()
    .max(50)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  passengerCapacity: z.coerce.number().int().min(1).max(20).default(4),
  luggageCapacity: z.coerce.number().int().min(0).max(20).default(2),
  displayOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export const updateVehicleTypeBodySchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  category: z.string().trim().optional(),
  hasAc: z.boolean().optional(),
  badge: z
    .string()
    .trim()
    .max(30)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  description: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  imageUrl: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  imageFileId: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  icon: z
    .string()
    .trim()
    .max(50)
    .nullable()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  passengerCapacity: z.coerce.number().int().min(1).max(20).optional(),
  luggageCapacity: z.coerce.number().int().min(0).max(20).optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const reorderVehicleTypesBodySchema = z.object({
  orderings: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(64),
        displayOrder: z.coerce.number().int().min(0),
      }),
    )
    .min(1),
});

export type ListVehiclesQuery = z.infer<typeof listVehiclesQuerySchema>;
export type FlagRenewalBody = z.infer<typeof flagRenewalBodySchema>;
export type CreateVehicleTypeBody = z.infer<typeof createVehicleTypeBodySchema>;
export type UpdateVehicleTypeBody = z.infer<typeof updateVehicleTypeBodySchema>;
export type ReorderVehicleTypesBody = z.infer<typeof reorderVehicleTypesBodySchema>;
