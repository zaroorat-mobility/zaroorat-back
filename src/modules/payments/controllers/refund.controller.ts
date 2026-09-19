import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerHasRole, callerId } from '@core/auth';
import { Decimal } from '../types/index.js';
import { PaymentService } from '../services/payment.service.js';
import type { RefundStaffScope } from '../services/refund/refund.service.js';
import { processRefundSchema } from '../schemas/payment.schemas.js';
export class RefundController {
  constructor(private readonly paymentService: PaymentService) {}
  async processRefund(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = processRefundSchema.parse(req.body);
    // Driver money (subscription, commission recharge) is FINANCE-only; SUPPORT
    // may still refund a customer's own wallet top-up on their behalf.
    const staffScope: RefundStaffScope = callerHasRole(req, 'finance', 'admin', 'system_admin')
      ? 'FINANCE'
      : callerHasRole(req, 'support')
        ? 'SUPPORT'
        : 'NONE';
    const result = await this.paymentService.withIdempotency(
      userId,
      '/refunds',
      idempotencyKey,
      body,
      async () => {
        const refundRecord = await this.paymentService.refund.processRefund({
          transactionId: body.transactionId,
          userId,
          amount: new Decimal(body.amount),
          idempotencyKey: idempotencyKey as string,
          staffScope,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        });
        return {
          id: refundRecord.id,
          transactionId: refundRecord.transactionId,
          amount: refundRecord.amount.toNumber(),
          status: refundRecord.status,
        };
      },
    );
    reply.send({ data: result });
  }
}
