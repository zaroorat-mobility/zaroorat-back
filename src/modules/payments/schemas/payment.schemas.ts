import { z } from 'zod';
export const topupWalletSchema = z.object({
  amount: z.number().positive({ message: 'Amount must be greater than zero' }),
  referenceId: z.string().uuid().optional(),
  description: z.string().max(255).optional(),
  /// How the rider intends to fund the top-up. Optional and additive: an
  /// existing client that sends neither gets a card intent.
  methodType: z.enum(['CARD', 'UPI', 'NETBANKING']).optional(),
});
export type TopupWalletBody = z.infer<typeof topupWalletSchema>;
export const holdWalletSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().max(255).optional(),
  referenceId: z.string().uuid().optional(),
});
export type HoldWalletBody = z.infer<typeof holdWalletSchema>;
/// `rideId` is deliberately absent. A client may fund its own wallet; it may
/// not declare which ride a payment settles, because that let a rider point a
/// 1-rupee intent at a 500-rupee fare (FR-012). Which ride an intent belongs
/// to is decided server-side, from the ride's own fare.
export const createIntentSchema = z.object({
  amount: z.number().positive(),
  methodType: z.enum(['CARD', 'UPI', 'NETBANKING', 'WALLET']),
  paymentMethodId: z.string().uuid().optional(),
});
export type CreateIntentBody = z.infer<typeof createIntentSchema>;
export const processRefundSchema = z.object({
  transactionId: z.string().uuid(),
  amount: z.number().positive(),
  reason: z.string().max(255).optional(),
});
export type ProcessRefundBody = z.infer<typeof processRefundSchema>;
export const executePayoutSchema = z.object({
  driverId: z.string().uuid(),
  settlementId: z.string().uuid().optional(),
  bankAccountId: z.string().uuid().optional(),
  amount: z.number().positive(),
});
export type ExecutePayoutBody = z.infer<typeof executePayoutSchema>;
