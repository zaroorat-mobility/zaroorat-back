import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DatabaseService } from '@core/database';
import { Decimal } from '@modules/payments/types/index.js';
import { PaymentService } from '@modules/payments/services/payment.service.js';
import {
  confirmPayoutSchema,
  executePayoutSchema,
  failPayoutSchema,
  payoutIdParamSchema,
} from '@modules/payments/schemas/payment.schemas.js';
import { recordAdminAction } from '../audit/index.js';
import type { DriverPayout } from '@modules/payments/types';

function payoutDto(payout: DriverPayout) {
  return {
    id: payout.id,
    driverId: payout.driverId,
    settlementId: payout.settlementId,
    bankAccountId: payout.bankAccountId,
    amount: payout.amount.toNumber(),
    status: payout.status,
    externalReference: payout.externalReference,
    failureReason: payout.failureReason,
    initiatedAt: payout.initiatedAt.toISOString(),
    completedAt: payout.completedAt?.toISOString() ?? null,
  };
}

export class AdminPaymentManagementController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly db: DatabaseService,
  ) {}

  /// Records the INTENT to pay a driver. No money moves here and no provider
  /// is called — the payout lands in INITIATED and reserves its amount against
  /// the settlement until finance confirms or fails it.
  async executePayout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = executePayoutSchema.parse(req.body);

    const result = await this.paymentService.withIdempotency(
      userId,
      '/admin/payments/payouts',
      idempotencyKey,
      body,
      async () => {
        const payout = await this.paymentService.payout.executePayout({
          driverId: body.driverId,
          bankAccountId: body.bankAccountId,
          amount: new Decimal(body.amount),
          idempotencyKey: idempotencyKey as string,
          ...(body.settlementId !== undefined ? { settlementId: body.settlementId } : {}),
        });
        await this.audit(
          userId,
          'CREATE',
          payout,
          `Payout initiated for driver ${payout.driverId}`,
        );
        return payoutDto(payout);
      },
    );
    reply.send({ data: result });
  }

  /// Finance confirms an externally executed bank transfer. This is the call
  /// that debits the driver wallet, posts the ledger entries, and can move the
  /// settlement to PAID.
  async confirmPayout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const { id } = payoutIdParamSchema.parse(req.params);
    const body = confirmPayoutSchema.parse(req.body);

    const payout = await this.paymentService.payout.confirmPayout({
      payoutId: id,
      externalReference: body.externalReference,
    });
    await this.audit(
      userId,
      'UPDATE',
      payout,
      `Payout confirmed against bank reference ${body.externalReference}`,
    );
    reply.send({ data: payoutDto(payout) });
  }

  /// Finance records that the transfer did not happen. The row is kept with a
  /// reason and the reservation is released.
  async failPayout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const { id } = payoutIdParamSchema.parse(req.params);
    const body = failPayoutSchema.parse(req.body);

    const payout = await this.paymentService.payout.failPayout({
      payoutId: id,
      reason: body.reason,
    });
    await this.audit(userId, 'UPDATE', payout, `Payout failed: ${body.reason}`);
    reply.send({ data: payoutDto(payout) });
  }

  /// Written after the payout transaction commits, unlike the other admin
  /// surfaces which audit inside their own transaction. `PayoutService` owns
  /// and closes its transaction rather than exposing it, and the primary
  /// auditable record here is the `DriverPayout` row itself — its status,
  /// bank reference, failure reason and timestamps — plus the outbox events.
  /// This log is a secondary index over those, so a crash between the two
  /// leaves the money correctly accounted for either way.
  private async audit(
    actorId: string,
    action: 'CREATE' | 'UPDATE',
    payout: DriverPayout,
    summary: string,
  ): Promise<void> {
    await recordAdminAction(this.db.client, {
      actorId,
      action,
      entityType: 'driver_payout',
      entityId: payout.id,
      summary,
      after: {
        status: payout.status,
        amount: payout.amount.toString(),
        driverId: payout.driverId,
        settlementId: payout.settlementId,
        externalReference: payout.externalReference,
        failureReason: payout.failureReason,
      },
    });
  }
}
