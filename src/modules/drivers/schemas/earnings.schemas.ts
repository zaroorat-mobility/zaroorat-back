import { z } from 'zod';

export const earningsPeriodSchema = z.enum(['today', 'week', 'month']);
export type EarningsPeriod = z.infer<typeof earningsPeriodSchema>;

export const earningsSummaryQuerySchema = z.object({
  period: earningsPeriodSchema.default('today'),
});

export const earningsRangeQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
});

export const earningsRidesQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const withdrawalCreateSchema = z.object({
  amount: z.number().positive().max(1_000_000),
  bankAccountId: z.string().uuid().optional(),
});

export const scheduledRideActionSchema = z.object({}).optional();
