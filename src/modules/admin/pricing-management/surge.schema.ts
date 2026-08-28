import { z } from 'zod';

export const createSurgeZoneSchema = z.object({
  cityCode: z.string().min(1),
  name: z.string().min(1),
  // GeoJSON Polygon coordinates: array of linear rings (each an array of [lng, lat])
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))).min(1),
});

export const updateSurgeZoneSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  coordinates: z
    .array(z.array(z.tuple([z.number(), z.number()])))
    .min(1)
    .optional(),
});

export const createSurgeWindowSchema = z
  .object({
    zoneId: z.string().uuid(),
    vehicleTypeId: z.string().uuid().optional(),
    multiplier: z.number().min(1.0).max(2.0),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
    reason: z.string().optional(),
    demandThresholdPct: z.number().min(0).max(100).optional(),
    supplyThresholdPct: z.number().min(0).max(100).optional(),
    peakHourStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    peakHourEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    isPeakHourOnly: z.boolean().optional(),
  })
  .refine((data) => !data.endsAt || new Date(data.startsAt) < new Date(data.endsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
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
    multiplier: z.number().min(1.0).max(2.0).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().optional(),
    demandThresholdPct: z.number().min(0).max(100).nullable().optional(),
    supplyThresholdPct: z.number().min(0).max(100).nullable().optional(),
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
  })
  .refine(
    (data) => {
      if (data.startsAt && data.endsAt) {
        return new Date(data.startsAt) < new Date(data.endsAt);
      }
      return true; // We can't fully validate against DB state here
    },
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  );
