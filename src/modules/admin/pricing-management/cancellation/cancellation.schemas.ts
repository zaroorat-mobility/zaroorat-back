import { z } from 'zod';
import { vehicleTypeCodeSchema } from '../fare/fare.schemas.js';

const nullableNonNegativeAmount = z.union([
  z.null(),
  z.number().finite().min(0).max(100_000),
]);

const actorEnum = z.enum(['rider', 'driver', 'RIDER', 'DRIVER']);
const scenarioEnum = z.enum([
  'before_assignment',
  'after_assignment',
  'after_arrival',
  'no_show',
  'BEFORE_ASSIGNMENT',
  'AFTER_ASSIGNMENT',
  'AFTER_ARRIVAL',
  'NO_SHOW',
]);
const chargeTypeEnum = z.enum(['fixed', 'percentage', 'FLAT', 'PERCENT']);
const feeBaseEnum = z.enum(['QUOTED_FARE', 'BASE_FARE', 'MINIMUM_FARE']);
const driverCompTypeEnum = z.enum(['NONE', 'FLAT', 'PERCENT_OF_FEE']);

export const listCancellationPoliciesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).optional().default('all'),
  actor: actorEnum.optional(),
  scenario: scenarioEnum.optional(),
  cityCode: z.string().trim().max(20).optional(),
  vehicleTypeId: z.string().uuid().optional(),
});

export const cancellationPolicyIdParamSchema = z.object({
  id: z.string().uuid(),
});

const baseCancellationPolicyFields = {
  ruleName: z.string().trim().min(1).max(120).optional(),
  actor: actorEnum,
  scenario: scenarioEnum,
  chargeType: chargeTypeEnum,
  chargeAmount: z.number().finite().min(0).max(100_000),
  feeBase: feeBaseEnum.optional().default('QUOTED_FARE'),
  maxFee: nullableNonNegativeAmount.optional(),
  freeCancelWindowSec: z.number().int().min(0).max(86_400).optional().default(120),
  driverCompensationType: driverCompTypeEnum.optional().default('NONE'),
  driverCompensationAmount: z.number().finite().min(0).max(100_000).optional().default(0),
  driverPenaltyAmount: nullableNonNegativeAmount.optional(),
  cityCode: z.string().trim().min(1).max(20).optional().nullable(),
  /// Exact type only (`vehicleTypeId`, or the exact code in `vehicleType`).
  vehicleTypeId: z.string().uuid().optional().nullable(),
  vehicleType: vehicleTypeCodeSchema.optional(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  effectiveTo: z.string().datetime({ offset: true }).optional().nullable(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
};

function refinePolicyRules(
  data: {
    chargeType?: string | undefined;
    chargeAmount?: number | undefined;
    driverCompensationType?: string | undefined;
    driverCompensationAmount?: number | undefined;
    effectiveFrom?: string | undefined;
    effectiveTo?: string | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    (data.chargeType === 'percentage' || data.chargeType === 'PERCENT') &&
    data.chargeAmount !== undefined &&
    data.chargeAmount > 100
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['chargeAmount'],
      message: 'Percentage chargeAmount must be between 0 and 100',
    });
  }

  if (
    data.driverCompensationType === 'PERCENT_OF_FEE' &&
    data.driverCompensationAmount !== undefined &&
    data.driverCompensationAmount > 100
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['driverCompensationAmount'],
      message: 'PERCENT_OF_FEE driverCompensationAmount must be between 0 and 100',
    });
  }

  if (data.effectiveFrom && data.effectiveTo) {
    const from = new Date(data.effectiveFrom);
    const to = new Date(data.effectiveTo);
    if (to <= from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTo'],
        message: 'effectiveTo must be strictly after effectiveFrom',
      });
    }
  }
}

export const createCancellationPolicyBodySchema = z
  .object(baseCancellationPolicyFields)
  .strict()
  .superRefine(refinePolicyRules);

export const updateCancellationPolicyBodySchema = z
  .object({
    ruleName: baseCancellationPolicyFields.ruleName,
    actor: actorEnum.optional(),
    scenario: scenarioEnum.optional(),
    chargeType: chargeTypeEnum.optional(),
    chargeAmount: z.number().finite().min(0).max(100_000).optional(),
    feeBase: feeBaseEnum.optional(),
    maxFee: nullableNonNegativeAmount.optional(),
    freeCancelWindowSec: z.number().int().min(0).max(86_400).optional(),
    driverCompensationType: driverCompTypeEnum.optional(),
    driverCompensationAmount: z.number().finite().min(0).max(100_000).optional(),
    driverPenaltyAmount: nullableNonNegativeAmount.optional(),
    cityCode: baseCancellationPolicyFields.cityCode,
    vehicleTypeId: baseCancellationPolicyFields.vehicleTypeId,
    vehicleType: baseCancellationPolicyFields.vehicleType,
    effectiveFrom: baseCancellationPolicyFields.effectiveFrom,
    effectiveTo: baseCancellationPolicyFields.effectiveTo,
    status: z.enum(['active', 'inactive']).optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine(refinePolicyRules);

export const evaluateCancellationPolicyBodySchema = z
  .object({
    actor: z.enum(['rider', 'driver', 'RIDER', 'DRIVER', 'CUSTOMER', 'SYSTEM']),
    scenario: scenarioEnum,
    cityCode: z.string().trim().min(1).max(20).optional().nullable(),
    vehicleTypeId: z.string().uuid().optional().nullable(),
    vehicleType: vehicleTypeCodeSchema.optional(),
    elapsedSec: z.number().int().min(0).max(86_400).default(0),
    quotedFare: z.number().finite().min(0).max(1_000_000).optional().default(0),
    baseFare: z.number().finite().min(0).max(1_000_000).optional(),
    minimumFare: z.number().finite().min(0).max(1_000_000).optional(),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type ListCancellationPoliciesQuery = z.infer<typeof listCancellationPoliciesQuerySchema>;
export type CreateCancellationPolicyBody = z.infer<typeof createCancellationPolicyBodySchema>;
export type UpdateCancellationPolicyBody = z.infer<typeof updateCancellationPolicyBodySchema>;
export type EvaluateCancellationPolicyBody = z.infer<typeof evaluateCancellationPolicyBodySchema>;
