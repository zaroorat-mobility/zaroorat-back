import { z } from 'zod';
import { vehicleTypeCodeSchema } from '../fare/fare.schemas.js';

export const listCancellationPoliciesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).optional().default('all'),
});

export const cancellationPolicyIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const createCancellationPolicyBodySchema = z.object({
  ruleName: z.string().trim().min(1).max(120).optional(),
  actor: z.enum(['rider', 'driver', 'RIDER', 'DRIVER']),
  scenario: z.enum([
    'before_assignment',
    'after_assignment',
    'after_arrival',
    'no_show',
    'BEFORE_ASSIGNMENT',
    'AFTER_ASSIGNMENT',
    'AFTER_ARRIVAL',
    'NO_SHOW',
  ]),
  chargeType: z.enum(['fixed', 'percentage', 'FLAT', 'PERCENT']),
  chargeAmount: z.coerce.number().min(0),
  freeCancelWindowSec: z.coerce.number().int().min(0).optional().default(120),
  cityCode: z.string().trim().max(20).optional().nullable(),
  /// Exact type only (`vehicleTypeId`, or the exact code in `vehicleType`); the
  /// old `cab -> CAB_ECONOMY` alias named a type the catalog no longer has.
  vehicleTypeId: z.string().uuid().optional().nullable(),
  vehicleType: vehicleTypeCodeSchema.optional(),
  status: z.enum(['active', 'inactive']).optional().default('active'),
});

export const updateCancellationPolicyBodySchema = createCancellationPolicyBodySchema.partial();

export type ListCancellationPoliciesQuery = z.infer<typeof listCancellationPoliciesQuerySchema>;
export type CreateCancellationPolicyBody = z.infer<typeof createCancellationPolicyBodySchema>;
export type UpdateCancellationPolicyBody = z.infer<typeof updateCancellationPolicyBodySchema>;
