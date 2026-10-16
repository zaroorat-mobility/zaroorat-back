import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverRepository } from '../repositories/driver.repository.js';
import { actingDriverId } from './driver-identity.js';
import { DriverMapZonesService } from '../services/map-zones/map-zones.service.js';
import { mapZonesQuerySchema } from '../schemas/map-zones.schemas.js';

export class DriverMapZonesController {
  constructor(
    private readonly driverMapZonesService: DriverMapZonesService,
    private readonly driverRepository: DriverRepository,
  ) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = mapZonesQuerySchema.parse(req.query);
    const driverId = await actingDriverId(req, this.driverRepository);
    const data = await this.driverMapZonesService.getZones(driverId, query.viewport, query.layers);
    reply.send({ data });
  }
}
