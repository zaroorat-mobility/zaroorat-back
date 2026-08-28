import { z } from 'zod';

export const referralAudienceSchema = z.enum(['RIDER', 'DRIVER']);
export const referralQualifyingEventSchema = z.enum([
  'SIGNUP',
  'FIRST_RIDE',
  'NTH_RIDE',
  'DRIVER_APPROVED',
  'DRIVER_FIRST_RIDE',
  'DRIVER_NTH_RIDE',
]);
export const referralRewardWalletSchema = z.enum(['CUSTOMER', 'DRIVER']);

const RIDER_QUALIFYING = ['SIGNUP', 'FIRST_RIDE', 'NTH_RIDE'] as const;
const DRIVER_QUALIFYING = ['DRIVER_APPROVED', 'DRIVER_FIRST_RIDE', 'DRIVER_NTH_RIDE'] as const;

function validateProgramAudience(body: {
  audience?: 'RIDER' | 'DRIVER';
  qualifyingEvent?: string;
  rewardWallet?: string;
}): boolean {
  const audience = body.audience ?? 'RIDER';
  const qualifyingEvent =
    body.qualifyingEvent ?? (audience === 'DRIVER' ? 'DRIVER_APPROVED' : 'FIRST_RIDE');
  const rewardWallet = body.rewardWallet ?? (audience === 'DRIVER' ? 'DRIVER' : 'CUSTOMER');

  if (audience === 'RIDER') {
    return (
      (RIDER_QUALIFYING as readonly string[]).includes(qualifyingEvent) &&
      rewardWallet === 'CUSTOMER'
    );
  }
  return (
    (DRIVER_QUALIFYING as readonly string[]).includes(qualifyingEvent) && rewardWallet === 'DRIVER'
  );
}

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).optional().default('all'),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const listProgramsQuerySchema = paginationQuerySchema.extend({
  audience: referralAudienceSchema.optional(),
});

const programBodyObjectSchema = z.object({
  code: z.string().trim().min(2).max(50).optional(),
  name: z.string().trim().max(200).optional().nullable(),
  audience: referralAudienceSchema.optional().default('RIDER'),
  referrerReward: z.coerce.number().min(0).optional().default(0),
  refereeReward: z.coerce.number().min(0).optional().default(0),
  rewardType: z.enum(['WALLET', 'CREDIT', 'PROMO']).optional().default('WALLET'),
  rewardWallet: referralRewardWalletSchema.optional(),
  qualifyingEvent: referralQualifyingEventSchema.optional(),
  qualifyingThreshold: z.coerce.number().int().min(1).max(100).optional().default(1),
  maxReferralsPerUser: z.coerce.number().int().min(1).optional().nullable(),
  rewardExpiryDays: z.coerce.number().int().min(1).optional().nullable(),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  isActive: z.boolean().optional().default(true),
});

export const createProgramBodySchema = programBodyObjectSchema
  .transform((body) => {
    const audience = body.audience ?? 'RIDER';
    return {
      ...body,
      audience,
      rewardWallet: body.rewardWallet ?? (audience === 'DRIVER' ? 'DRIVER' : 'CUSTOMER'),
      qualifyingEvent:
        body.qualifyingEvent ?? (audience === 'DRIVER' ? 'DRIVER_APPROVED' : 'FIRST_RIDE'),
    };
  })
  .refine((b) => b.validTo > b.validFrom, {
    message: 'validTo must be after validFrom',
    path: ['validTo'],
  })
  .refine((body) => validateProgramAudience(body), {
    message:
      'RIDER programs require CUSTOMER wallet and rider qualifying events; DRIVER programs require DRIVER wallet and driver qualifying events',
    path: ['audience'],
  });

export const updateProgramBodySchema = programBodyObjectSchema
  .partial()
  .refine((b) => b.validFrom == null || b.validTo == null || b.validTo > b.validFrom, {
    message: 'validTo must be after validFrom',
    path: ['validTo'],
  });

export type ListProgramsQuery = z.infer<typeof listProgramsQuerySchema>;
export type CreateProgramBody = z.infer<typeof createProgramBodySchema>;
export type UpdateProgramBody = z.infer<typeof updateProgramBodySchema>;

export const createMilestoneBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  requiredReferrals: z.coerce.number().int().min(1),
  bonusAmount: z.coerce.number().min(0),
  rewardType: z.enum(['WALLET', 'CREDIT', 'PROMO']).optional().default('WALLET'),
  isActive: z.boolean().optional().default(true),
});

export const updateMilestoneBodySchema = createMilestoneBodySchema.partial();

export type CreateMilestoneBody = z.infer<typeof createMilestoneBodySchema>;
export type UpdateMilestoneBody = z.infer<typeof updateMilestoneBodySchema>;

export const listCodesQuerySchema = paginationQuerySchema.extend({
  programId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  audience: referralAudienceSchema.optional(),
});

export type ListCodesQuery = z.infer<typeof listCodesQuerySchema>;

export const listReferralsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  programId: z.string().uuid().optional(),
  audience: referralAudienceSchema.optional(),
  status: z
    .enum(['all', 'PENDING', 'SIGNED_UP', 'QUALIFIED', 'REWARDED', 'EXPIRED', 'CANCELLED'])
    .optional()
    .default('all'),
});

export type ListReferralsQuery = z.infer<typeof listReferralsQuerySchema>;
