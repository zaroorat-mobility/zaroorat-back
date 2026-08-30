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
    // BD-4. New windows target the geographic module's service zone — the single
    // polygon of record. `zoneId` remains accepted while legacy surge polygons
    // exist and is removed with `SurgeZone` in the follow-up release.
    serviceZoneId: z.string().uuid().optional(),
    zoneId: z.string().uuid().optional(),
    vehicleTypeId: z.string().uuid().optional(),
    multiplier: z.number().min(1.0).max(2.0),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().optional(),
    reason: z.string().optional(),
    // FR-014. `demandThresholdPct` and `supplyThresholdPct` were accepted here,
    // stored, and evaluated by nothing — there is no demand or supply signal in
    // the system for them to be compared against. Removed rather than left
    // writable and inert: a knob that does nothing is how an operator concludes
    // a feature exists.
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
  .refine((data) => Boolean(data.serviceZoneId ?? data.zoneId), {
    message: 'serviceZoneId is required',
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
    multiplier: z.number().min(1.0).max(2.0).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    isActive: z.boolean().optional(),
    reason: z.string().optional(),
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
