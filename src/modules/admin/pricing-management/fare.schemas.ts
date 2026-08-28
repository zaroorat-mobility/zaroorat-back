import { z } from 'zod';

export const vehicleTypeCodeSchema = z.enum(['cab', 'auto', 'bike', 'CAB_ECONOMY', 'AUTO', 'BIKE']);

export const rideServiceTypeSchema = z.enum([
  'instant',
  'scheduled',
  'rental',
  'outstation',
  'INSTANT',
  'SCHEDULED',
  'RENTAL',
  'OUTSTATION',
]);

export const listFareRulesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).optional().default('all'),
  cityCode: z.string().trim().max(20).optional(),
});

export const fareRuleIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const listServiceZonesQuerySchema = z.object({
  cityCode: z.string().trim().min(1).max(20),
});

const fareRuleFieldsSchema = z.object({
  ruleName: z.string().trim().min(1).max(120).optional(),
  vehicleType: vehicleTypeCodeSchema,
  cityCode: z.string().trim().min(1).max(20).default('GLOBAL'),
  serviceType: rideServiceTypeSchema.optional().nullable(),
  serviceZoneId: z.string().uuid().optional().nullable(),
  baseFare: z.coerce.number().min(0),
  minimumFare: z.coerce.number().min(0),
  perKmRate: z.coerce.number().min(0),
  perMinuteRate: z.coerce.number().min(0),
  freeWaitingMinutes: z.coerce.number().int().min(0).default(3),
  waitingChargePerMinute: z.coerce.number().min(0).default(0),
  bookingFee: z.coerce.number().min(0).default(0),
  platformFeePct: z.coerce.number().min(0).max(100).default(0),
  taxRatePct: z.coerce.number().min(0).max(100).optional(),
  commissionRatePct: z.coerce.number().min(0).max(100).optional(),
  nightEnabled: z.boolean().optional().default(false),
  nightChargePercentage: z.coerce.number().min(0).max(100).optional(),
  nightStartTime: z.string().optional(),
  nightEndTime: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().optional(),
});

export const createFareRuleBodySchema = fareRuleFieldsSchema;

export const updateFareRuleBodySchema = fareRuleFieldsSchema.partial().extend({
  vehicleType: vehicleTypeCodeSchema.optional(),
  cityCode: z.string().trim().min(1).max(20).optional(),
  effectiveFrom: z.string().min(1).optional(),
});

export type ListFareRulesQuery = z.infer<typeof listFareRulesQuerySchema>;
export type CreateFareRuleBody = z.infer<typeof createFareRuleBodySchema>;
export type UpdateFareRuleBody = z.infer<typeof updateFareRuleBodySchema>;
