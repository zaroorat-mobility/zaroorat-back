import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminPricingSimulateService } from './simulate.service.js';
import { simulatePricingBodySchema } from './simulate.schemas.js';

export class AdminPricingSimulateController {
  constructor(private readonly adminPricingSimulateService: AdminPricingSimulateService) {}

  async simulate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = simulatePricingBodySchema.parse(req.body ?? {});
    const data = await this.adminPricingSimulateService.simulate(body);
    reply.send({ data });
  }
}
