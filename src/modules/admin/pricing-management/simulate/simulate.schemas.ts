import { z } from 'zod';
import { rideServiceTypeSchema, vehicleTypeCodeSchema } from '../fare/fare.schemas.js';

export const simulatePricingBodySchema = z
  .object({
    vehicleTypeId: z.string().uuid().optional(),
    vehicleType: vehicleTypeCodeSchema.optional(),
    cityCode: z.string().trim().min(1).max(20).default('GLOBAL'),
    serviceType: rideServiceTypeSchema.optional().nullable(),
    serviceZoneId: z.string().uuid().optional().nullable(),
    pickupLat: z.number().finite().min(-90).max(90).optional(),
    pickupLng: z.number().finite().min(-180).max(180).optional(),
    distanceKm: z.number().finite().min(0).max(2000),
    durationMin: z.number().finite().min(0).max(1440),
    waitingMinutes: z.number().finite().min(0).max(600).default(0),
    surgeMultiplier: z.number().finite().min(1).max(10).optional(),
    discountAmount: z.number().finite().min(0).default(0),
    at: z
      .string()
      .trim()
      .refine((v) => !Number.isNaN(new Date(v).getTime()), {
        message: 'at must be a valid ISO-8601 date-time string',
      })
      .optional(),
  })
  .strict()
  .refine((body) => Boolean(body.vehicleTypeId || body.vehicleType), {
    message: 'vehicleTypeId (or exact vehicleType code) is required',
    path: ['vehicleTypeId'],
  });

export type SimulatePricingBody = z.infer<typeof simulatePricingBodySchema>;
