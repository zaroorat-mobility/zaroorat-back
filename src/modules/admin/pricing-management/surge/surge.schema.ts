import { z } from 'zod';

const daysOfWeekSchema = z.array(z.number().int().min(0).max(6)).max(7);

export const listSurgeWindowsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['all', 'active', 'inactive']).optional().default('all'),
  cityCode: z.string().trim().max(20).optional(),
  search: z.string().trim().max(120).optional(),
});

/// The legal limit in one city. MAX_SURGE_MULTIPLIER stays the platform limit above it.
export const updateCitySurgeSettingsSchema = z
  .object({
    maxSurgeMultiplier: z.number().finite().min(1).max(2),
  })
  .strict();

export const createSurgeZoneSchema = z
  .object({
    cityCode: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    // GeoJSON Polygon coordinates: array of linear rings (each an array of [lng, lat])
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))).min(1),
  })
  .strict();

export const updateSurgeZoneSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
    coordinates: z
      .array(z.array(z.tuple([z.number(), z.number()])))
      .min(1)
      .optional(),
  })
  .strict();

export const createSurgeWindowSchema = z
  .object({
    // Phase 2.3 (M-08): A window targets a ServiceZone, a whole City (`cityCode`),
    // or (legacy) a SurgeZone polygon.
    serviceZoneId: z.string().uuid().optional(),
    zoneId: z.string().uuid().optional(),
    cityCode: z.string().trim().min(1).max(20).optional(),
    /// Legacy single-vehicle field (still accepted for backward compatibility).
    vehicleTypeId: z.string().uuid().optional(),
    /// Phase 2.3: Multi-vehicle targeting in one atomic window. Empty = all vehicles.
    vehicleTypeIds: z.array(z.string().uuid()).max(50).optional(),
    multiplier: z.number().finite().min(1.0).max(2.0),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
    reason: z.string().trim().max(255).optional(),
    peakHourStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    peakHourEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    isPeakHourOnly: z.boolean().optional(),
    daysOfWeek: daysOfWeekSchema.optional(),
  })
  .strict()
  .refine((data) => !data.endsAt || new Date(data.startsAt) < new Date(data.endsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })
  .refine((data) => Boolean(data.serviceZoneId ?? data.zoneId ?? data.cityCode), {
    message: 'One of serviceZoneId, cityCode, or zoneId is required',
    path: ['serviceZoneId'],
  })
  .refine(
    (data) => {
      if (data.isPeakHourOnly) {
        return Boolean(data.peakHourStart && data.peakHourEnd);
      }
      return true;
    },
    {
      message: 'peakHourStart and peakHourEnd are required when isPeakHourOnly is true',
      path: ['peakHourStart'],
    },
  );

export const updateSurgeWindowSchema = z
  .object({
    serviceZoneId: z.string().uuid().nullable().optional(),
    cityCode: z.string().trim().min(1).max(20).nullable().optional(),
    vehicleTypeIds: z.array(z.string().uuid()).max(50).optional(),
    multiplier: z.number().finite().min(1.0).max(2.0).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().trim().max(255).nullable().optional(),
    peakHourStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    peakHourEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    isPeakHourOnly: z.boolean().optional(),
    daysOfWeek: daysOfWeekSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.startsAt && data.endsAt) {
        return new Date(data.startsAt) < new Date(data.endsAt);
      }
      return true;
    },
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  );

export type ListSurgeWindowsQuery = z.infer<typeof listSurgeWindowsQuerySchema>;
