import { z } from 'zod';

export const liveSummaryQuerySchema = z.object({
  longWaitThresholdMin: z.coerce.number().int().min(1).max(60).default(5),
});

export type LiveSummaryQuery = z.infer<typeof liveSummaryQuerySchema>;

export const activeRidesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'])
    .optional()
    .default('all'),
});

export type ActiveRidesQuery = z.infer<typeof activeRidesQuerySchema>;

export const liveMapQuerySchema = z.object({
  city: z.string().trim().optional(),
  vehicleTypeId: z.string().uuid().optional(),
});

export type LiveMapQuery = z.infer<typeof liveMapQuerySchema>;

export const liveDriversQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'ONLINE', 'ON_TRIP', 'BUSY', 'OFFLINE', 'BREAK'])
    .optional()
    .default('all'),
  vehicleTypeId: z.string().uuid().optional(),
});

export type LiveDriversQuery = z.infer<typeof liveDriversQuerySchema>;

export const liveAlertsQuerySchema = z.object({
  longWaitThresholdMin: z.coerce.number().int().min(1).max(60).default(5),
});

export type LiveAlertsQuery = z.infer<typeof liveAlertsQuerySchema>;
