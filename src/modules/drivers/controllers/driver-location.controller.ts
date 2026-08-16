import type { FastifyReply, FastifyRequest } from 'fastify';
import { DriverService } from '../services/driver.service.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import type { UpdateDriverLocationInput } from '../repositories/driver-location.repository.js';
import { updateLocationSchema } from '../schemas/driver.schemas.js';
import { actingDriverId, authorizedDriverId } from './driver-identity.js';
export class DriverLocationController {
  constructor(
    private readonly driverService: DriverService,
    private readonly driverRepository: DriverRepository,
  ) {}
  async updateLocation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const body = updateLocationSchema.parse(req.body);
    const locationParams: UpdateDriverLocationInput = {
      driverId,
      latitude: body.latitude,
      longitude: body.longitude,
      ...(body.heading !== undefined ? { heading: body.heading } : {}),
      ...(body.bearing !== undefined ? { bearing: body.bearing } : {}),
      ...(body.speedKmh !== undefined ? { speedKmh: body.speedKmh } : {}),
      ...(body.accuracyMeters !== undefined ? { accuracyMeters: body.accuracyMeters } : {}),
      ...(body.isMockLocation !== undefined ? { isMockLocation: body.isMockLocation } : {}),
      ...(body.rideId !== undefined ? { rideId: body.rideId } : {}),
    };
    const location = await this.driverService.location.updateLocation(locationParams);
    reply.send({ data: location });
  }
  async getLocation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as {
      id: string;
    };
    const driverId = await authorizedDriverId(req, this.driverRepository, id);
    const location = await this.driverService.location.getLocation(driverId);
    reply.send({ data: location });
  }
}
