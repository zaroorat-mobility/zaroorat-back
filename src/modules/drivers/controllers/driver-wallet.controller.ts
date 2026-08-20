import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverService } from '../services/driver.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { authorizedDriverId } from './driver-identity.js';
export class DriverWalletController {
  constructor(
    private readonly driverService: DriverService,
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
    const wallet = await this.driverService.wallet.getWallet(driverId);
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
    const txs = await this.driverService.wallet.listTransactions(driverId);
    reply.send({ data: txs });
  }
}
