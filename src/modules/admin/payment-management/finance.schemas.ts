import { z } from 'zod';

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
});

export const listFinanceTransactionsQuerySchema = paginationSchema.extend({
  status: z.string().trim().optional(),
  varianceStatus: z.string().trim().optional(),
  paymentMethod: z.string().trim().optional(),
  paymentGateway: z.string().trim().optional(),
  type: z.string().trim().optional(),
});

export const financeIdParamSchema = z.object({
  id: z.string().trim().min(1).max(120),
});

export const driverIdParamSchema = z.object({
  driverId: z.string().uuid(),
});

export const reconcileTransactionBodySchema = z.object({
  varianceStatus: z.enum(['matched', 'variance_found', 'under_review', 'resolved']),
  notes: z.string().trim().max(2000).optional(),
});

export const listFinanceRefundsQuerySchema = paginationSchema.extend({
  status: z.string().trim().optional(),
});

export const createFinanceRefundBodySchema = z
  .object({
    transactionId: z.string().uuid().optional(),
    rideId: z.string().uuid().optional(),
    disputeId: z.string().uuid().optional(),
    riderId: z.string().uuid().optional(),
    riderName: z.string().trim().max(200).optional(),
    refundType: z
      .enum([
        'RIDE_CANCELLED',
        'FARE_OVERCHARGED',
        'DOUBLE_PAYMENT',
        'PAYMENT_FAILURE',
        'DRIVER_NO_SHOW',
        'SERVICE_ISSUE',
        'GOODWILL_COMPENSATION',
        'DISPUTE_RESOLUTION',
      ])
      .default('SERVICE_ISSUE'),
    requestedAmount: z.coerce.number().positive(),
    reason: z.string().trim().min(1).max(2000),
    refundSource: z.enum(['dispute', 'complaint', 'ride', 'manual']).default('manual'),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Boolean(v.transactionId || v.rideId), {
    message: 'Either transactionId or rideId is required',
  });

export const startRefundReviewBodySchema = z.object({
  reviewerName: z.string().trim().min(1).max(200).optional(),
});

export const approveRefundBodySchema = z.object({
  approvedAmount: z.coerce.number().positive(),
  notes: z.string().trim().max(2000).optional(),
  reviewerName: z.string().trim().min(1).max(200).optional(),
});

export const rejectRefundBodySchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  reviewerName: z.string().trim().min(1).max(200).optional(),
});

export const markRefundProcessingBodySchema = z.object({
  actorName: z.string().trim().min(1).max(200).optional(),
});

export const markRefundCompletedBodySchema = z.object({
  actorName: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const listSettlementsQuerySchema = paginationSchema.extend({
  status: z.string().trim().optional(),
});

export const generateSettlementBodySchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

export const settlementStatusBodySchema = z.object({
  status: z.enum(['draft', 'pending', 'processing', 'completed', 'failed']),
});

export const searchDriversQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
});

export const driverBreakdownQuerySchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

export const listDisputesQuerySchema = paginationSchema.extend({
  status: z.string().trim().optional(),
  type: z.string().trim().optional(),
});

export const createDisputeBodySchema = z.object({
  rideId: z.string().uuid(),
  complaintId: z.string().uuid().optional(),
  type: z.enum([
    'FARE_DIFFERENCE',
    'UNCOLLECTED_CASH',
    'DOUBLE_CHARGE',
    'REFUND_REQUEST',
    'SURGE_DISPUTE',
    'CANCELLATION_FEE_DISPUTE',
    'WAITING_CHARGE_DISPUTE',
    'OTHER',
  ]),
  riderId: z.string().uuid().optional(),
  riderName: z.string().trim().max(200).optional(),
  driverId: z.string().uuid().optional(),
  driverName: z.string().trim().max(200).optional(),
  amount: z.coerce.number().nonnegative(),
  requestedAmount: z.coerce.number().nonnegative().optional(),
  reason: z.string().trim().min(1).max(4000),
});

export const assignDisputeBodySchema = z.object({
  agentName: z.string().trim().min(1).max(200),
});

export const updateDisputeStatusBodySchema = z.object({
  status: z.enum(['open', 'assigned', 'investigating', 'pending_approval', 'resolved', 'closed']),
  notes: z.string().trim().max(2000).optional(),
});

export const resolveDisputeBodySchema = z.object({
  resolutionType: z.enum([
    'Approve Refund',
    'Reject Claim',
    'Reverse Driver Due',
    'Adjust Fare',
    'Mark Paid',
    'Write Off',
  ]),
  resolutionNotes: z.string().trim().max(4000).optional(),
  adjustmentAmount: z.coerce.number().optional(),
  resolvedBy: z.string().trim().min(1).max(200).optional(),
});

export const closeDisputeBodySchema = z.object({
  notes: z.string().trim().max(2000).optional(),
});

export const listFinanceAuditQuerySchema = paginationSchema.extend({
  module: z.string().trim().optional(),
  severity: z.string().trim().optional(),
});

export type ListFinanceTransactionsQuery = z.infer<typeof listFinanceTransactionsQuerySchema>;
export type ReconcileTransactionBody = z.infer<typeof reconcileTransactionBodySchema>;
export type ListFinanceRefundsQuery = z.infer<typeof listFinanceRefundsQuerySchema>;
export type CreateFinanceRefundBody = z.infer<typeof createFinanceRefundBodySchema>;
export type ListSettlementsQuery = z.infer<typeof listSettlementsQuerySchema>;
export type GenerateSettlementBody = z.infer<typeof generateSettlementBodySchema>;
export type SettlementStatusBody = z.infer<typeof settlementStatusBodySchema>;
export type ListDisputesQuery = z.infer<typeof listDisputesQuerySchema>;
export type CreateDisputeBody = z.infer<typeof createDisputeBodySchema>;
export type ListFinanceAuditQuery = z.infer<typeof listFinanceAuditQuerySchema>;
