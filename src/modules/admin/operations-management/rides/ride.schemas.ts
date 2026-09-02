import { z } from 'zod';

export const listAdminRidesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .enum([
      'all',
      'REQUESTED',
      'SEARCHING',
      'ACCEPTED',
      'DRIVER_ARRIVING',
      'DRIVER_ARRIVED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED_BY_CUSTOMER',
      'CANCELLED_BY_DRIVER',
      'CANCELLED_BY_SYSTEM',
      'NO_DRIVERS_FOUND',
    ])
    .optional()
    .default('all'),
  paymentStatus: z
    .enum([
      'all',
      'PENDING',
      'AUTHORIZED',
      'PAID',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'FAILED',
      'CANCELLED',
    ])
    .optional()
    .default('all'),
  paymentMethod: z
    .enum(['all', 'CASH', 'CARD', 'WALLET', 'UPI', 'NET_BANKING'])
    .optional()
    .default('all'),
  vehicleTypeId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  cityCode: z.string().trim().max(20).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const rideIdParamSchema = z.object({
  id: z.string().trim().min(1).max(100),
});

export const exportAdminRidesQuerySchema = listAdminRidesQuerySchema.omit({
  page: true,
  limit: true,
});

export const addRideNoteBodySchema = z.object({
  note: z.string().trim().min(1).max(2000),
});

export const cancelRideBodySchema = z.object({
  reasonCode: z.string().trim().max(50).default('ADMIN_CANCELLED'),
  reasonText: z.string().trim().max(500).optional(),
});

export const listRideAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListAdminRidesQuery = z.infer<typeof listAdminRidesQuerySchema>;
export type ExportAdminRidesQuery = z.infer<typeof exportAdminRidesQuerySchema>;
export type AddRideNoteBody = z.infer<typeof addRideNoteBodySchema>;
export type CancelRideBody = z.infer<typeof cancelRideBodySchema>;
export type ListRideAuditLogsQuery = z.infer<typeof listRideAuditLogsQuerySchema>;
