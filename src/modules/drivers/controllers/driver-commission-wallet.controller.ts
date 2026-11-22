import type { FastifyReply, FastifyRequest } from 'fastify';
import { CommissionWalletService } from '@modules/payments/services/commission-wallet/commission-wallet.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { authorizedDriverId } from './driver-identity.js';
export class DriverCommissionWalletController {
  constructor(
    private readonly commissionWalletService: CommissionWalletService,
    private readonly driverRepository: DriverRepository,
  ) {}
  async getWallet(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await authorizedDriverId(
      req,
      this.driverRepository,
      (
        req.params as {
          driverId?: string;
        }
      )?.driverId,
    );
    const wallet = await this.commissionWalletService.getWallet(driverId);
    reply.send({ data: wallet });
  }
  async listTransactions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await authorizedDriverId(
      req,
      this.driverRepository,
      (
        req.params as {
          driverId?: string;
        }
      )?.driverId,
    );
    const txs = await this.commissionWalletService.listTransactions(driverId);
    reply.send({ data: txs });
  }
}
