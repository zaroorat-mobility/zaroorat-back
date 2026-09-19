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

/// The resulting configuration of a program — after create defaults or an
/// update merged over the stored row — or null when it is valid. Shared by the
/// create schema (400) and the admin service's update path (409).
export function programConfigError(p: {
  audience: 'RIDER' | 'DRIVER';
  qualifyingEvent: string;
  rewardWallet: string | undefined;
  referrerReward: number;
  refereeReward: number;
  isActive: boolean;
}): string | null {
  if (p.audience === 'DRIVER') {
    return (DRIVER_QUALIFYING as readonly string[]).includes(p.qualifyingEvent) &&
      p.rewardWallet === 'DRIVER'
      ? null
      : 'DRIVER programs require DRIVER wallet and driver qualifying events';
  }
  if (!(RIDER_QUALIFYING as readonly string[]).includes(p.qualifyingEvent)) {
    return 'RIDER programs require rider qualifying events';
  }
  // Customer wallet retirement: Zaroorat holds no customer money, so a RIDER
  // program has no wallet to pay into — CUSTOMER is retired and DRIVER would
  // turn a rider reward into a driver one. Rider referrals are non-monetary.
  if (p.rewardWallet !== undefined) {
    return 'RIDER programs cannot set rewardWallet: rider referral rewards are non-monetary';
  }
  // Checked only while active, so a legacy program that still carries amounts
  // can be edited and deactivated — the runtime pays it nothing either way.
  if (p.isActive && (p.referrerReward > 0 || p.refereeReward > 0)) {
    return 'An active RIDER program cannot have a monetary referrer or referee reward';
  }
  return null;
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

/// No `.default()` here, on purpose. Zod 4 applies a default even inside
/// `.partial()`, so a default on this shared shape made every PATCH that
/// omitted a field overwrite it — `audience` back to RIDER, both amounts to 0,
/// `isActive` to true. CREATE defaults live in `createProgramBodySchema`'s
/// transform; the update schema leaves an omitted field `undefined`, which
/// the service reads as "keep the stored value".
const programBodyObjectSchema = z.object({
  code: z.string().trim().min(2).max(50).optional(),
  name: z.string().trim().max(200).optional().nullable(),
  audience: referralAudienceSchema.optional(),
  referrerReward: z.coerce.number().min(0).optional(),
  refereeReward: z.coerce.number().min(0).optional(),
  rewardType: z.enum(['WALLET', 'CREDIT', 'PROMO']).optional(),
  rewardWallet: referralRewardWalletSchema.optional(),
  qualifyingEvent: referralQualifyingEventSchema.optional(),
  qualifyingThreshold: z.coerce.number().int().min(1).max(100).optional(),
  maxReferralsPerUser: z.coerce.number().int().min(1).optional().nullable(),
  // BD-8 / FR-046. `rewardExpiryDays` named a behaviour it did not have: it
  // bounds how long the referee has to qualify, and never expired a granted
  // reward. Both accepted during the expand phase; the new name wins.
  qualificationWindowDays: z.coerce.number().int().min(1).optional().nullable(),
  rewardExpiryDays: z.coerce.number().int().min(1).optional().nullable(),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  isActive: z.boolean().optional(),
});

export const createProgramBodySchema = programBodyObjectSchema
  .transform((body) => {
    const audience = body.audience ?? 'RIDER';
    return {
      ...body,
      audience,
      referrerReward: body.referrerReward ?? 0,
      refereeReward: body.refereeReward ?? 0,
      rewardType: body.rewardType ?? 'WALLET',
      qualifyingThreshold: body.qualifyingThreshold ?? 1,
      isActive: body.isActive ?? true,
      rewardWallet: body.rewardWallet ?? (audience === 'DRIVER' ? ('DRIVER' as const) : undefined),
      qualifyingEvent:
        body.qualifyingEvent ?? (audience === 'DRIVER' ? 'DRIVER_APPROVED' : 'FIRST_RIDE'),
    };
  })
  .refine((b) => b.validTo > b.validFrom, {
    message: 'validTo must be after validFrom',
    path: ['validTo'],
  })
  .superRefine((body, ctx) => {
    const message = programConfigError(body);
    if (message) ctx.addIssue({ code: 'custom', message, path: ['audience'] });
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

/// Same reason as `programBodyObjectSchema`: no defaults on the shared shape.
const milestoneBodyObjectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  requiredReferrals: z.coerce.number().int().min(1),
  bonusAmount: z.coerce.number().min(0),
  rewardType: z.enum(['WALLET', 'CREDIT', 'PROMO']).optional(),
  isActive: z.boolean().optional(),
});

export const createMilestoneBodySchema = milestoneBodyObjectSchema.transform((body) => ({
  ...body,
  rewardType: body.rewardType ?? 'WALLET',
  isActive: body.isActive ?? true,
}));

export const updateMilestoneBodySchema = milestoneBodyObjectSchema.partial();

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
