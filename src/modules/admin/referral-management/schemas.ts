import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z.enum(['all', 'active', 'inactive']).optional().default('all'),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const listProgramsQuerySchema = paginationQuerySchema;

const programBodyObjectSchema = z.object({
  code: z.string().trim().min(2).max(50).optional(),
  name: z.string().trim().max(200).optional().nullable(),
  referrerReward: z.coerce.number().min(0).optional().default(0),
  refereeReward: z.coerce.number().min(0).optional().default(0),
  rewardType: z.enum(['WALLET', 'CREDIT', 'PROMO']).optional().default('WALLET'),
  qualifyingEvent: z.enum(['FIRST_RIDE', 'NTH_RIDE', 'SIGNUP']).optional().default('FIRST_RIDE'),
  qualifyingThreshold: z.coerce.number().int().min(1).max(100).optional().default(1),
  maxReferralsPerUser: z.coerce.number().int().min(1).optional().nullable(),
  rewardExpiryDays: z.coerce.number().int().min(1).optional().nullable(),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  isActive: z.boolean().optional().default(true),
});

export const createProgramBodySchema = programBodyObjectSchema.refine(
  (b) => b.validTo > b.validFrom,
  { message: 'validTo must be after validFrom', path: ['validTo'] },
);

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
});

export type ListCodesQuery = z.infer<typeof listCodesQuerySchema>;

export const listReferralsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  programId: z.string().uuid().optional(),
  status: z
    .enum(['all', 'PENDING', 'SIGNED_UP', 'QUALIFIED', 'REWARDED', 'EXPIRED', 'CANCELLED'])
    .optional()
    .default('all'),
});

export type ListReferralsQuery = z.infer<typeof listReferralsQuerySchema>;
