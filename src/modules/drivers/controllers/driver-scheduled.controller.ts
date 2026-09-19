import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverRepository } from '../repositories/driver.repository.js';
import { actingDriverId } from './driver-identity.js';
import { ScheduledRideService } from '@modules/rides/services/scheduled/scheduled-ride.service.js';

export class DriverScheduledController {
  constructor(
    private readonly scheduledRideService: ScheduledRideService,
    private readonly driverRepository: DriverRepository,
  ) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const data = await this.scheduledRideService.listForDriver(driverId);
    reply.send({ data });
  }
}
