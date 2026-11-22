import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { PaymentService } from '../services/payment.service.js';
import type { WalletView } from '../schemas/payment.responses.js';
export class WalletController {
  constructor(private readonly paymentService: PaymentService) {}
  async getBalance(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const wallet = await this.paymentService.wallet.getWallet(userId);
    const balanceNum = wallet?.balance.toNumber() ?? 0;
    const lockedNum = wallet?.lockedBalance.toNumber() ?? 0;
    const view: WalletView = {
      id: wallet?.id ?? null,
      userId,
      balance: balanceNum,
      lockedBalance: lockedNum,
      availableBalance: balanceNum - lockedNum,
      currency: wallet?.currency ?? 'INR',
    };
    reply.send({ data: view });
  }
}
