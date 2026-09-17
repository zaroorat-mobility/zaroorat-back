import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverRepository } from '../repositories/driver.repository.js';
import { actingDriverId } from './driver-identity.js';
import { DriverWithdrawalService } from '../services/withdrawal/withdrawal.service.js';
import { withdrawalCreateSchema } from '../schemas/earnings.schemas.js';

export class DriverWithdrawalController {
  constructor(
    private readonly driverWithdrawalService: DriverWithdrawalService,
    private readonly driverRepository: DriverRepository,
  ) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const data = await this.driverWithdrawalService.list(driverId);
    reply.send({ data });
  }

  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const body = withdrawalCreateSchema.parse(req.body);
    const data = await this.driverWithdrawalService.create(
      driverId,
      body.amount,
      body.bankAccountId,
    );
    reply.status(201).send({ data });
  }
}
