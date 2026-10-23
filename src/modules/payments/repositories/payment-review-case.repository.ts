import type { Prisma } from '../../../generated/prisma';
import { Decimal } from '../types/index.js';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { ReviewCaseKind } from '../constants/payment.constants.js';
export interface OpenReviewCaseInput {
  kind: ReviewCaseKind;
  intentId: string | null;
  paymentTransactionId: string | null;
  gateway: string;
  providerPaymentId: string;
  providerOrderId: string | null;
  expectedAmount: Decimal | null;
  observedAmount: Decimal;
  expectedCurrency: string | null;
  observedCurrency: string;
  /// Sanitised provider fields only (data-model §5): no contact, email, VPA or card data.
  evidence: Prisma.InputJsonObject;
}
export type ReviewResolution = 'RESOLVED_CREDIT' | 'RESOLVED_REFUND' | 'RESOLVED_NO_ACTION';
/// 005-razorpay-driver-payments T023 (TD-9). The Finance queue of captured
/// payments that could not be applied automatically.
export class PaymentReviewCaseRepository {
  constructor(private readonly db: DatabaseService) {}
  /// `INSERT … ON CONFLICT (kind, provider_payment_id) DO NOTHING`. True only
  /// for the call that opened the case, so a redelivery alerts nobody twice.
  async openIfAbsent(input: OpenReviewCaseInput, tx?: TransactionClient): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.paymentReviewCase.createMany({
      data: [input],
      skipDuplicates: true,
    });
    return count === 1;
  }
  async listOpen(limit = 100, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    return client.paymentReviewCase.findMany({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
  async findById(id: string, tx?: TransactionClient) {
    const client = tx ?? this.db.client;
    return client.paymentReviewCase.findUnique({ where: { id } });
  }
  /// Conditional claim: only an OPEN case resolves, and only once. False means
  /// someone else resolved it first.
  async claimResolution(
    id: string,
    resolution: {
      status: ReviewResolution;
      resolvedBy: string;
      resolutionNote: string;
      refundId?: string;
    },
    tx?: TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.db.client;
    const { count } = await client.paymentReviewCase.updateMany({
      where: { id, status: 'OPEN' },
      data: { ...resolution, resolvedAt: new Date() },
    });
    return count === 1;
  }
}
