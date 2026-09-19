import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverRepository } from '../repositories/driver.repository.js';
import { actingDriverId } from './driver-identity.js';
import { DriverEarningsService } from '../services/earnings/earnings.service.js';
import {
  earningsRangeQuerySchema,
  earningsRidesQuerySchema,
  earningsSummaryQuerySchema,
} from '../schemas/earnings.schemas.js';

export class DriverEarningsController {
  constructor(
    private readonly driverEarningsService: DriverEarningsService,
    private readonly driverRepository: DriverRepository,
  ) {}

  async summary(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const query = earningsSummaryQuerySchema.parse(req.query);
    const data = await this.driverEarningsService.getSummary(driverId, query.period);
    reply.send({ data });
  }

  async daily(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const query = earningsRangeQuerySchema.parse(req.query);
    if (query.to <= query.from) {
      reply.status(400).send({
        error: { code: 'VALIDATION', message: '`to` must be after `from`' },
      });
      return;
    }
    const result = await this.driverEarningsService.getDaily(driverId, query.from, query.to);
    reply.send(result);
  }

  async rides(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const query = earningsRidesQuerySchema.parse(req.query);
    const result = await this.driverEarningsService.listCompletedRides(driverId, {
      limit: query.limit,
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    reply.send(result);
  }
}
