import { z } from 'zod';

const scopeInputSchema = z
  .object({
    cityCode: z.string().trim().min(1).max(20).optional().nullable(),
    serviceZoneId: z.string().uuid().optional().nullable(),
    vehicleTypeId: z.string().uuid().optional().nullable(),
  })
  .strict();

const applyToNewRidesOnly = z
  .literal('NEW_RIDES_ONLY', {
    error: 'Only NEW_RIDES_ONLY is permitted. Existing accepted rides retain immutable snapshots.',
  })
  .default('NEW_RIDES_ONLY');

export const governanceIdParamSchema = z.object({ id: z.string().uuid() });
export const governanceScopeParamSchema = z.object({
  id: z.string().uuid(),
  scopeId: z.string().uuid(),
});

// ─── M-03 Commission Configuration ────────────────────────────────────────────

export const createCommissionConfigSchema = z
  .object({
    commissionRatePct: z.number().finite().min(0).max(50),
    isEnabled: z.boolean().optional().default(true),
    baseRule: z
      .enum([
        'RIDE_SUBTOTAL_BEFORE_DISCOUNT',
        'RIDE_SUBTOTAL_AFTER_DISCOUNT',
        'PRE_TAX_TOTAL',
      ])
      .optional()
      .default('RIDE_SUBTOTAL_BEFORE_DISCOUNT'),
    includeSurge: z.boolean().optional().default(true),
    includeWaiting: z.boolean().optional().default(false),
    includeBookingFee: z.boolean().optional().default(false),
    applyMinimumFloor: z.boolean().optional().default(true),
    roundOffRupee: z.boolean().optional().default(false),
    applyTo: applyToNewRidesOnly,
    declaredEffectiveFrom: z.string().datetime({ offset: true }).optional(),
    declaredEffectiveTo: z.string().datetime({ offset: true }).optional().nullable(),
    reason: z.string().trim().max(500).optional().nullable(),
    scopes: z.array(scopeInputSchema).min(1).max(100),
  })
  .strict()
  .refine(
    (d) =>
      !d.declaredEffectiveFrom ||
      !d.declaredEffectiveTo ||
      new Date(d.declaredEffectiveTo) > new Date(d.declaredEffectiveFrom),
    { path: ['declaredEffectiveTo'], message: 'declaredEffectiveTo must be after declaredEffectiveFrom' },
  );

// ─── M-04a Tax Configuration (No GSTIN/PAN accepted; No auto SAC 9964) ────────

export const createTaxConfigSchema = z
  .object({
    kind: z.enum(['PASSENGER_RIDE_GST', 'COMMISSION_GST']),
    ratePct: z.number().finite().min(0).max(28),
    isEnabled: z.boolean().optional().default(false),
    inclusive: z.boolean().optional().default(false),
    waitingTaxable: z.boolean().nullable().optional(),
    sacCode: z.string().trim().min(4).max(16).nullable().optional(),
    legalReference: z.string().trim().min(3).max(300).nullable().optional(),
    applyTo: applyToNewRidesOnly,
    declaredEffectiveFrom: z.string().datetime({ offset: true }).optional(),
    declaredEffectiveTo: z.string().datetime({ offset: true }).optional().nullable(),
    scopes: z.array(scopeInputSchema).min(1).max(100),
  })
  .strict()
  .refine(
    (d) =>
      !d.declaredEffectiveFrom ||
      !d.declaredEffectiveTo ||
      new Date(d.declaredEffectiveTo) > new Date(d.declaredEffectiveFrom),
    { path: ['declaredEffectiveTo'], message: 'declaredEffectiveTo must be after declaredEffectiveFrom' },
  );

// ─── M-04b Independent Driver GST Wallet Recovery Configuration ───────────────

export const createGstRecoveryConfigSchema = z
  .object({
    recoveryRatePct: z.number().finite().min(0).max(28),
    isEnabled: z.boolean().optional().default(false),
    baseRule: z
      .enum(['PASSENGER_GST_AMOUNT', 'TAXABLE_VALUE', 'RIDE_SUBTOTAL_BEFORE_DISCOUNT'])
      .optional()
      .default('PASSENGER_GST_AMOUNT'),
    roundOffRupee: z.boolean().optional().default(false),
    legalReference: z.string().trim().max(300).nullable().optional(),
    applyTo: applyToNewRidesOnly,
    declaredEffectiveFrom: z.string().datetime({ offset: true }).optional(),
    declaredEffectiveTo: z.string().datetime({ offset: true }).optional().nullable(),
    scopes: z.array(scopeInputSchema).min(1).max(100),
  })
  .strict()
  .refine(
    (d) =>
      !d.declaredEffectiveFrom ||
      !d.declaredEffectiveTo ||
      new Date(d.declaredEffectiveTo) > new Date(d.declaredEffectiveFrom),
    { path: ['declaredEffectiveTo'], message: 'declaredEffectiveTo must be after declaredEffectiveFrom' },
  );

// ─── M-04c Multi-Entity & Multi-State Legal Jurisdiction ──────────────────────

export const createLegalEntitySchema = z
  .object({
    legalEntityName: z.string().trim().min(2).max(200),
    tradeName: z.string().trim().max(200).optional().nullable(),
    pan: z.string().trim().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN must match 10-character Indian PAN format'),
    headOfficeAddress: z.string().trim().min(5).max(500),
    isActive: z.boolean().optional().default(true),
  })
  .strict();

export const updateLegalEntitySchema = createLegalEntitySchema.partial().strict();

export const createGstRegistrationSchema = z
  .object({
    gstin: z
      .string()
      .trim()
      .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'GSTIN must match 15-character Indian GSTIN format'),
    stateCode: z.string().trim().regex(/^[0-9]{2}$/, 'stateCode must be a 2-digit Indian GST state code'),
    stateName: z.string().trim().min(2).max(100),
    registrationAddress: z.string().trim().min(5).max(500),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    effectiveTo: z.string().datetime({ offset: true }).optional().nullable(),
    isActive: z.boolean().optional().default(true),
  })
  .strict()
  .refine((d) => d.gstin.startsWith(d.stateCode), {
    path: ['gstin'],
    message: 'First 2 digits of GSTIN must match stateCode',
  });

export const listTaxConfigsQuerySchema = z.object({
  kind: z.enum(['PASSENGER_RIDE_GST', 'COMMISSION_GST']).optional(),
});

export const listCitySupplyRegistrationsQuerySchema = z.object({
  cityCode: z.string().trim().min(1).max(20).optional(),
});

export const createCitySupplyRegistrationSchema = z
  .object({
    cityCode: z.string().trim().min(2).max(20),
    supplyKind: z.enum(['PASSENGER_RIDE', 'PLATFORM_COMMISSION']),
    legalEntityId: z.string().uuid(),
    gstRegistrationId: z.string().uuid(),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    effectiveTo: z.string().datetime({ offset: true }).optional().nullable(),
    isActive: z.boolean().optional().default(true),
  })
  .strict();

// ─── Settlement Failure Recovery & Waiver ─────────────────────────────────────

export const listSettlementFailuresQuerySchema = z.object({
  status: z.enum(['OPEN', 'RECOVERED', 'WAIVED']).optional(),
  kind: z.enum(['COMMISSION', 'GST_RECOVERY']).optional(),
  driverId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const waiveSettlementFailureBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type CreateCommissionConfigBody = z.infer<typeof createCommissionConfigSchema>;
export type CreateTaxConfigBody = z.infer<typeof createTaxConfigSchema>;
export type CreateGstRecoveryConfigBody = z.infer<typeof createGstRecoveryConfigSchema>;
export type CreateLegalEntityBody = z.infer<typeof createLegalEntitySchema>;
export type UpdateLegalEntityBody = z.infer<typeof updateLegalEntitySchema>;
export type CreateGstRegistrationBody = z.infer<typeof createGstRegistrationSchema>;
export type CreateCitySupplyRegistrationBody = z.infer<typeof createCitySupplyRegistrationSchema>;
export type ListSettlementFailuresQuery = z.infer<typeof listSettlementFailuresQuerySchema>;
export type WaiveSettlementFailureBody = z.infer<typeof waiveSettlementFailureBodySchema>;
