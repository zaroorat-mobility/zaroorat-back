import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { Decimal } from '../types/index.js';
import { PaymentService } from '../services/payment.service.js';
import { topupWalletSchema, holdWalletSchema } from '../schemas/payment.schemas.js';
import type { WalletView } from '../schemas/payment.responses.js';

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
        const wallet = await this.paymentService.wallet.topup(
          userId,
          new Decimal(body.amount),
          body.referenceId,
          body.description,
        );
        const balanceNum = wallet.balance.toNumber();
        const lockedNum = wallet.lockedBalance.toNumber();
        return {
          id: wallet.id,
          userId: wallet.userId,
          balance: balanceNum,
          lockedBalance: lockedNum,
          availableBalance: balanceNum - lockedNum,
          currency: wallet.currency,
        } satisfies WalletView;
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
