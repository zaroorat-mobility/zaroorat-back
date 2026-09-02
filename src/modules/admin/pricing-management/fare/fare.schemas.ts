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
const fareRuleFieldsSchema = z.object({
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
  /// FR-009. The flat platform fee this rule charges when `platformFeePct` is 0.
  /// Omit it to inherit the environment default; send 0 to mean no platform fee,
  /// which was previously impossible to express — a zero percentage silently
  /// fell through to the env's flat fee.
  platformFeeFlat: z.coerce.number().min(0).optional(),
  taxRatePct: z.coerce.number().min(0).max(100).optional(),
  commissionRatePct: z.coerce.number().min(0).max(100).optional(),
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
