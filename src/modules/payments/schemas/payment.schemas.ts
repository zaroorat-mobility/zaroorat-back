import { z } from 'zod';
/// 004-driver-subscription-wallet. Exactly one of amount/rechargeOptionId —
/// spec.md FR-008/FR-008a. Validated server-side against the configured
/// min/max (custom) or the active option list (predefined) before any
/// payment is initiated; never trusted from the client beyond "which one."
export const rechargeCommissionWalletSchema = z
  .object({
    amount: z.number().positive().optional(),
    rechargeOptionId: z.string().uuid().optional(),
  })
  .refine((body) => (body.amount != null) !== (body.rechargeOptionId != null), {
    message: 'Provide exactly one of amount or rechargeOptionId',
  });
export type RechargeCommissionWalletBody = z.infer<typeof rechargeCommissionWalletSchema>;
export const processRefundSchema = z.object({
  transactionId: z.string().uuid(),
  amount: z.number().positive(),
  reason: z.string().max(255).optional(),
});
export type ProcessRefundBody = z.infer<typeof processRefundSchema>;
export const executePayoutSchema = z.object({
  driverId: z.string().uuid(),
  settlementId: z.string().uuid().optional(),
  /// Required. It used to be optional, which meant the bank-account checks a
  /// payout depends on — ownership, verification, payoutEnabled — had nothing
  /// to run against; when omitted the service passed the literal string
  /// 'default' to the gateway. You cannot pay someone without an account.
  bankAccountId: z.string().uuid(),
  amount: z.number().positive(),
});
export type ExecutePayoutBody = z.infer<typeof executePayoutSchema>;

/// Finance recording that a bank transfer for this payout actually executed.
/// The reference is the bank's own (UTR/NEFT ref) and is the audit link
/// between this row and the money that left the platform's account, so it is
/// mandatory and non-empty.
export const confirmPayoutSchema = z.object({
  externalReference: z.string().trim().min(1).max(140),
});
export type ConfirmPayoutBody = z.infer<typeof confirmPayoutSchema>;

export const failPayoutSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type FailPayoutBody = z.infer<typeof failPayoutSchema>;

export const payoutIdParamSchema = z.object({
  id: z.string().uuid(),
});
