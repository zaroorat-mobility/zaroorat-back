import { z } from 'zod';
export const purchaseSubscriptionSchema = z.object({
  planId: z.string().uuid(),
});
export type PurchaseSubscriptionBody = z.infer<typeof purchaseSubscriptionSchema>;
export const createSubscriptionPlanSchema = z.object({
  name: z.string().min(1).max(100),
  billingPeriod: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  price: z.number().positive(),
  currency: z.string().length(3).optional(),
});
export type CreateSubscriptionPlanBody = z.infer<typeof createSubscriptionPlanSchema>;
