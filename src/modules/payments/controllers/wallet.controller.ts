import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { Decimal } from '../types/index.js';
import { PaymentService } from '../services/payment.service.js';
import { topupWalletSchema, holdWalletSchema } from '../schemas/payment.schemas.js';
import type { WalletTopupView, WalletView } from '../schemas/payment.responses.js';
export class WalletController {
  constructor(private readonly paymentService: PaymentService) {}
  async getBalance(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const wallet = await this.paymentService.wallet.getWallet(userId);
    const balanceNum = wallet.balance.toNumber();
    const lockedNum = wallet.lockedBalance.toNumber();
    const view: WalletView = {
      id: wallet.id,
      userId: wallet.userId,
      balance: balanceNum,
      lockedBalance: lockedNum,
      availableBalance: balanceNum - lockedNum,
      currency: wallet.currency,
    };
    reply.send({ data: view });
  }
  async topup(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = topupWalletSchema.parse(req.body);
    const result = await this.paymentService.withIdempotency(
      userId,
      '/wallet/topup',
      idempotencyKey,
      body,
      async () => {
        // A top-up now *starts* a payment rather than being one. The balance
        // rises when the gateway confirms and not a moment sooner, so what
        // comes back here is the current balance plus the intent to pay.
        const intent = await this.paymentService.intent.createIntent({
          userId,
          amount: new Decimal(body.amount),
          methodType: body.methodType ?? 'CARD',
          idempotencyKey: idempotencyKey as string,
        });
        const wallet = await this.paymentService.wallet.getWallet(userId);
        const balanceNum = wallet.balance.toNumber();
        const lockedNum = wallet.lockedBalance.toNumber();
        return {
          id: wallet.id,
          userId: wallet.userId,
          balance: balanceNum,
          lockedBalance: lockedNum,
          availableBalance: balanceNum - lockedNum,
          currency: wallet.currency,
          intentId: intent.id,
          intentStatus: intent.status,
          gateway: intent.gateway,
          gatewayIntentId: intent.gatewayIntentId,
          amount: intent.amount.toNumber(),
        } satisfies WalletTopupView;
      },
    );
    reply.send({ data: result });
  }
  async hold(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const body = holdWalletSchema.parse(req.body);
    const result = await this.paymentService.withIdempotency(
      userId,
      '/wallet/hold',
      idempotencyKey,
      body,
      async () => {
        const holdRecord = await this.paymentService.wallet.hold(
          userId,
          new Decimal(body.amount),
          body.reason,
          body.referenceId,
        );
        return {
          id: holdRecord.id,
          amount: holdRecord.amount.toNumber(),
          status: holdRecord.status,
        };
      },
    );
    reply.send({ data: result });
  }
}
