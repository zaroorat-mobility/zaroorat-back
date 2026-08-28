import { z } from 'zod';

const polygonCoordinatesSchema = z.array(z.array(z.tuple([z.number(), z.number()]))).min(1);

const pointSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

export const serviceZoneTypeSchema = z.enum(['SERVICE', 'AIRPORT', 'RESTRICTED']);

export const listStatesQuerySchema = z.object({
  countryCode: z.string().trim().min(1).max(10).optional(),
  activeOnly: z.coerce.boolean().optional().default(false),
});

export const listCitiesQuerySchema = z.object({
  countryCode: z.string().trim().max(10).optional(),
  stateId: z.string().uuid().optional(),
  activeOnly: z.coerce.boolean().optional().default(false),
});

export const cityIdParamSchema = z.object({ id: z.string().uuid() });
export const stateIdParamSchema = z.object({ id: z.string().uuid() });
export const serviceZoneIdParamSchema = z.object({ id: z.string().uuid() });

export const createCityBodySchema = z.object({
  code: z.string().trim().min(2).max(20),
  name: z.string().trim().min(1).max(120),
  stateId: z.string().uuid().optional().nullable(),
  timezone: z.string().trim().max(60).optional(),
  currency: z.string().trim().length(3).optional(),
  launchedAt: z.string().optional(),
  center: pointSchema.optional(),
  boundary: polygonCoordinatesSchema.optional(),
  isActive: z.boolean().optional().default(true),
});

export const updateCityBodySchema = createCityBodySchema.partial().extend({
  code: z.string().trim().min(2).max(20).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

export const createStateBodySchema = z.object({
  countryCode: z.string().trim().min(1).max(10).default('IN'),
  code: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().optional().default(true),
});

export const updateStateBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
});

export const listServiceZonesQuerySchema = z.object({
  cityCode: z.string().trim().min(1).max(20).optional(),
  zoneType: serviceZoneTypeSchema.optional(),
  activeOnly: z.coerce.boolean().optional().default(false),
});

export const createServiceZoneBodySchema = z.object({
  cityCode: z.string().trim().min(1).max(20),
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  zoneType: serviceZoneTypeSchema.default('SERVICE'),
  coordinates: polygonCoordinatesSchema,
  allowsPickup: z.boolean().optional().default(true),
  allowsDropoff: z.boolean().optional().default(true),
  vehicleTypeIds: z.array(z.string().uuid()).optional(),
  isActive: z.boolean().optional().default(true),
});

export const updateServiceZoneBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  zoneType: serviceZoneTypeSchema.optional(),
  coordinates: polygonCoordinatesSchema.optional(),
  allowsPickup: z.boolean().optional(),
  allowsDropoff: z.boolean().optional(),
  vehicleTypeIds: z.array(z.string().uuid()).optional(),
  isActive: z.boolean().optional(),
});

export type CreateCityBody = z.infer<typeof createCityBodySchema>;
export type UpdateCityBody = z.infer<typeof updateCityBodySchema>;
export type CreateStateBody = z.infer<typeof createStateBodySchema>;
export type UpdateStateBody = z.infer<typeof updateStateBodySchema>;
export type CreateServiceZoneBody = z.infer<typeof createServiceZoneBodySchema>;
export type UpdateServiceZoneBody = z.infer<typeof updateServiceZoneBodySchema>;
