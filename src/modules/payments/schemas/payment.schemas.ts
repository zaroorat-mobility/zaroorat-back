import { z } from 'zod';
export const topupWalletSchema = z.object({
  amount: z.number().positive({ message: 'Amount must be greater than zero' }),
  referenceId: z.string().uuid().optional(),
  description: z.string().max(255).optional(),
});
export type TopupWalletBody = z.infer<typeof topupWalletSchema>;
export const holdWalletSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().max(255).optional(),
  referenceId: z.string().uuid().optional(),
});
export type HoldWalletBody = z.infer<typeof holdWalletSchema>;
export const createIntentSchema = z.object({
  amount: z.number().positive(),
  methodType: z.enum(['CARD', 'UPI', 'NETBANKING', 'WALLET']),
  paymentMethodId: z.string().uuid().optional(),
  rideId: z.string().uuid().optional(),
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
