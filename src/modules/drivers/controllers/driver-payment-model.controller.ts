import type { FastifyReply, FastifyRequest } from 'fastify';
import { PaymentModelService } from '../services/payment-model/payment-model.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { selectPaymentModelSchema } from '../schemas/driver.schemas.js';
import { actingDriverId } from './driver-identity.js';
export class DriverPaymentModelController {
  constructor(
    private readonly paymentModelService: PaymentModelService,
    private readonly driverRepository: DriverRepository,
  ) {}
  async select(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const { model } = selectPaymentModelSchema.parse(req.body);
    const status = await this.paymentModelService.select(driverId, model);
    reply.send({ data: status });
  }
  async getStatus(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const status = await this.paymentModelService.getStatus(driverId);
    reply.send({ data: status });
  }
  async getCommissionTerms(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const query = (req.query ?? {}) as { cityCode?: string; vehicleTypeId?: string };
    const terms = await this.paymentModelService.getCommissionTerms(driverId, {
      cityCode: query.cityCode ?? null,
      vehicleTypeId: query.vehicleTypeId ?? null,
    });
    reply.send({ data: terms });
  }
}
