import { z } from 'zod';

/// FR-036. Vehicle types are rows in `vehicle_types`, not a literal list.
///
/// This was `z.enum(['cab', 'auto', 'bike', 'CAB_ECONOMY', 'AUTO', 'BIKE'])`,
/// which rejected `CAB_PREMIUM` — a code the same file's `CODE_TO_UI` map
/// already knows about, and which an operator can create at any time through
/// vehicle-type management. Adding a category therefore silently made it
/// impossible to price. The value is validated against the table in
/// `AdminFareService.resolveVehicleType`, which is the only place that can
/// answer the question correctly.
export const vehicleTypeCodeSchema = z.string().trim().min(1).max(40);

/// BD-5 option B. `SCHEDULED`, `RENTAL` and `OUTSTATION` are removed from what an
/// admin may create, because nothing in the ride paths ever passes a
/// `serviceType` — `findBestActiveRule` defaults to `INSTANT`, so a rule created
/// for any of the other three was listable, activatable and unreachable by every
/// ride the platform will ever price.
///
/// The enum values stay in the database and in `findBestActiveRule`, which
/// resolves them correctly and has a committed test proving it. What is removed
/// is the ability to write rows the runtime cannot read. Threading `serviceType`
/// through booking is its own feature, with the scheduled- and rental-flow
/// product decisions that go with it.
export const rideServiceTypeSchema = z.enum(['instant', 'INSTANT']);

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

/// FR-037. `ruleName`, `nightStartTime` and `nightEndTime` were accepted here
/// and written nowhere: `ruleName` is derived in `toDto` from the rule's own
/// key, and the two night times had no column at all. FR-047 takes
/// `nightEnabled` and `nightChargePercentage` with them — they reached
/// `night_multiplier`, which no reachable code path charges.
///
/// A field an admin form can submit and the server discards is worse than a
/// missing field: the operator sets it, sees it accepted, and believes it holds.
///
/// `vehicleTypeId` is the preferred way to name the type; `vehicleType` (the
/// exact code) is still accepted for older admin builds. Both must name one row.
const effectiveDateStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: 'Must be a valid ISO-8601 date or date-time string',
  });

const nullableRate = (min: number, max: number) =>
  z.union([z.null(), z.number().finite().min(min).max(max)]).optional();

const fareRuleFieldsSchema = z
  .object({
    vehicleTypeId: z.string().uuid().optional(),
    vehicleType: vehicleTypeCodeSchema.optional(),
    cityCode: z.string().trim().min(1).max(20).default('GLOBAL'),
    serviceType: rideServiceTypeSchema.optional().nullable(),
    serviceZoneId: z.string().uuid().optional().nullable(),
    baseFare: z.number().finite().min(0).max(50_000),
    minimumFare: z.number().finite().min(0).max(50_000),
    perKmRate: z.number().finite().min(0).max(5_000),
    perMinuteRate: z.number().finite().min(0).max(1_000),
    freeWaitingMinutes: z.number().int().min(0).max(120).default(3),
    waitingChargePerMinute: z.number().finite().min(0).max(1_000).default(0),
    bookingFee: z.number().finite().min(0).max(5_000).default(0),
    platformFeePct: z.number().finite().min(0).max(100).default(0),
    /// FR-009 / Phase 1.2: `null` explicitly clears a per-rule override (inherit default);
    /// `0` explicitly sets zero; `undefined` leaves untouched on PATCH.
    platformFeeFlat: nullableRate(0, 5_000),
    taxRatePct: nullableRate(0, 100),
    commissionRatePct: nullableRate(0, 100),
    status: z.enum(['active', 'inactive']).optional().default('active'),
    effectiveFrom: effectiveDateStringSchema,
    effectiveTo: effectiveDateStringSchema.nullable().optional(),
  })
  .strict();

export const createFareRuleBodySchema = fareRuleFieldsSchema
  .refine((body) => Boolean(body.vehicleTypeId || body.vehicleType), {
    message: 'vehicleTypeId (or the exact vehicleType code) is required',
    path: ['vehicleTypeId'],
  })
  .superRefine((body, ctx) => {
    if (body.effectiveTo) {
      const from = new Date(body.effectiveFrom).getTime();
      const to = new Date(body.effectiveTo).getTime();
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effectiveTo'],
          message: 'effectiveTo must be strictly after effectiveFrom',
        });
      }
    }
  });

export const updateFareRuleBodySchema = fareRuleFieldsSchema
  .partial()
  .extend({
    cityCode: z.string().trim().min(1).max(20).optional(),
    effectiveFrom: effectiveDateStringSchema.optional(),
    expectedVersion: z.coerce.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.effectiveFrom && body.effectiveTo) {
      const from = new Date(body.effectiveFrom).getTime();
      const to = new Date(body.effectiveTo).getTime();
      if (to <= from) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effectiveTo'],
          message: 'effectiveTo must be strictly after effectiveFrom',
        });
      }
    }
  });

/// An unsaved rule plus a trip, priced by PricingService exactly as a ride would be. Rates use
/// the same fields and rules as saving: an omitted or null tax/commission rate is the platform default.
export const previewFareRuleBodySchema = z.object({
  baseFare: z.coerce.number().min(0).max(50_000),
  minimumFare: z.coerce.number().min(0).max(50_000),
  perKmRate: z.coerce.number().min(0).max(5_000),
  perMinuteRate: z.coerce.number().min(0).max(1_000),
  freeWaitingMinutes: z.coerce.number().int().min(0).max(120).default(3),
  waitingChargePerMinute: z.coerce.number().min(0).max(1_000).default(0),
  bookingFee: z.coerce.number().min(0).max(5_000).default(0),
  platformFeePct: z.number().finite().min(0).max(100).default(0),
  platformFeeFlat: nullableRate(0, 5_000),
  taxRatePct: nullableRate(0, 100),
  commissionRatePct: nullableRate(0, 100),
  distanceKm: z.coerce.number().min(0).max(2000),
  durationMin: z.coerce.number().min(0).max(1440),
  waitingMinutes: z.coerce.number().min(0).max(600).default(0),
  surgeMultiplier: z.coerce.number().min(1).max(10).default(1),
  discountAmount: z.coerce.number().min(0).default(0),
  fareCeiling: z.coerce.number().min(0).optional(),
});

export type PreviewFareRuleBody = z.infer<typeof previewFareRuleBodySchema>;
export type ListFareRulesQuery = z.infer<typeof listFareRulesQuerySchema>;
export type CreateFareRuleBody = z.infer<typeof createFareRuleBodySchema>;
export type UpdateFareRuleBody = z.infer<typeof updateFareRuleBodySchema>;
