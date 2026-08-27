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

const discountTypeSchema = z.enum([
  'PERCENT',
  'FIXED',
  'percent',
  'fixed',
  'PERCENTAGE',
  'percentage',
]);

export const listPromotionsQuerySchema = paginationQuerySchema;

const promotionBodyObjectSchema = z.object({
  code: z.string().trim().min(2).max(50).optional(),
  title: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  discountType: discountTypeSchema,
  discountValue: z.coerce.number().positive(),
  maxDiscount: z.coerce.number().min(0).optional().nullable(),
  minFare: z.coerce.number().min(0).optional().default(0),
  applicableCity: z.string().trim().max(40).optional().nullable(),
  applicableVehicleTypeId: z.string().uuid().optional().nullable(),
  firstRideOnly: z.boolean().optional().default(false),
  usageLimitTotal: z.coerce.number().int().positive().optional().nullable(),
  usageLimitPerUser: z.coerce.number().int().min(1).optional().default(1),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  isActive: z.boolean().optional().default(true),
});

export const createPromotionBodySchema = promotionBodyObjectSchema.refine(
  (b) => b.validTo > b.validFrom,
  {
    message: 'validTo must be after validFrom',
    path: ['validTo'],
  },
);

export const updatePromotionBodySchema = promotionBodyObjectSchema
  .partial()
  .refine((b) => b.validFrom == null || b.validTo == null || b.validTo > b.validFrom, {
    message: 'validTo must be after validFrom',
    path: ['validTo'],
  });

export type ListPromotionsQuery = z.infer<typeof listPromotionsQuerySchema>;
export type CreatePromotionBody = z.infer<typeof createPromotionBodySchema>;
export type UpdatePromotionBody = z.infer<typeof updatePromotionBodySchema>;

export const listCampaignsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'])
    .optional()
    .default('all'),
});

export const createCampaignBodySchema = z.object({
  code: z.string().trim().min(2).max(50).optional(),
  name: z.string().trim().min(1).max(200),
  objective: z
    .enum(['ACQUISITION', 'RETENTION', 'REACTIVATION', 'AWARENESS'])
    .optional()
    .default('ACQUISITION'),
  status: z
    .enum(['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'])
    .optional()
    .default('DRAFT'),
  budget: z.coerce.number().min(0).optional().nullable(),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
});

export const updateCampaignBodySchema = createCampaignBodySchema.partial();

export const setCampaignTargetsBodySchema = z.object({
  targets: z
    .array(
      z.object({
        segmentId: z.string().uuid(),
        promotionId: z.string().uuid().optional().nullable(),
      }),
    )
    .max(50),
});

export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;
export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;
export type SetCampaignTargetsBody = z.infer<typeof setCampaignTargetsBodySchema>;

export const listSegmentsQuerySchema = paginationQuerySchema.omit({ status: true }).extend({
  status: z.enum(['all']).optional().default('all'),
});

export const createSegmentBodySchema = z.object({
  code: z.string().trim().min(2).max(50).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  rules: z
    .object({
      cityCodes: z.array(z.string()).optional(),
      vehicleTypeIds: z.array(z.string().uuid()).optional(),
      firstRideOnly: z.boolean().optional(),
      userIds: z.array(z.string().uuid()).optional(),
    })
    .optional()
    .nullable(),
  estimatedSize: z.coerce.number().int().min(0).optional().nullable(),
  isDynamic: z.boolean().optional().default(true),
});

export const updateSegmentBodySchema = createSegmentBodySchema.partial();

export type ListSegmentsQuery = z.infer<typeof listSegmentsQuerySchema>;
export type CreateSegmentBody = z.infer<typeof createSegmentBodySchema>;
export type UpdateSegmentBody = z.infer<typeof updateSegmentBodySchema>;

export const listCouponBatchesQuerySchema = paginationQuerySchema;
export const createCouponBatchBodySchema = z.object({
  promotionId: z.string().uuid(),
  campaignId: z.string().uuid().optional().nullable(),
  name: z.string().trim().max(200).optional().nullable(),
  prefix: z.string().trim().max(20).optional().nullable(),
  totalCount: z.coerce.number().int().min(1).max(10000),
  perUserLimit: z.coerce.number().int().min(1).max(100).optional().default(1),
  expiresAt: z.coerce.date().optional().nullable(),
  isActive: z.boolean().optional().default(true),
  generateNow: z.boolean().optional().default(true),
});

export const generateCouponsBodySchema = z.object({
  count: z.coerce.number().int().min(1).max(5000),
});

export const listCouponsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  batchId: z.string().uuid().optional(),
  status: z
    .enum(['all', 'ACTIVE', 'ASSIGNED', 'REDEEMED', 'EXPIRED', 'VOID'])
    .optional()
    .default('all'),
  search: z.string().trim().max(50).optional(),
});

export type ListCouponBatchesQuery = z.infer<typeof listCouponBatchesQuerySchema>;
export type CreateCouponBatchBody = z.infer<typeof createCouponBatchBodySchema>;
export type GenerateCouponsBody = z.infer<typeof generateCouponsBodySchema>;
export type ListCouponsQuery = z.infer<typeof listCouponsQuerySchema>;

const optionalHttpUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().url().max(2000).nullable().optional(),
);

export const listBannersQuerySchema = paginationQuerySchema;
export const createBannerBodySchema = z.object({
  campaignId: z.string().uuid().optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  imageUrl: z.string().url().max(2000),
  placement: z.enum(['HOME', 'RIDE', 'WALLET', 'SPLASH', 'OFFERS']).optional().default('HOME'),
  actionUrl: optionalHttpUrl,
  priority: z.coerce.number().int().min(0).max(1000).optional().default(0),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

export const updateBannerBodySchema = z.object({
  campaignId: z.string().uuid().optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  imageUrl: z.string().url().max(2000).optional(),
  placement: z.enum(['HOME', 'RIDE', 'WALLET', 'SPLASH', 'OFFERS']).optional(),
  actionUrl: optionalHttpUrl,
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  isActive: z.boolean().optional(),
});

export type ListBannersQuery = z.infer<typeof listBannersQuerySchema>;
export type CreateBannerBody = z.infer<typeof createBannerBodySchema>;
export type UpdateBannerBody = z.infer<typeof updateBannerBodySchema>;

export const reportOverviewQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type ReportOverviewQuery = z.infer<typeof reportOverviewQuerySchema>;
