import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverNotFoundError } from '@modules/drivers/errors/driver.errors.js';
import { VehicleAssignmentService } from '../services/vehicle-assignment.service.js';
import { claimVehicleSchema } from '../schemas/vehicle.schemas.js';
export class VehicleController {
  constructor(
    private readonly vehicleAssignmentService: VehicleAssignmentService,
    private readonly driverRepository: DriverRepository,
  ) {}
  async claim(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);
    const driver = await this.driverRepository.findByUserId(userId);
    if (!driver) throw new DriverNotFoundError(userId);
    const body = claimVehicleSchema.parse(req.body);
    const vehicle = await this.vehicleAssignmentService.claimVehicle({
      driverId: driver.id,
      registrationNumber: body.registrationNumber,
      vehicleTypeId: body.vehicleTypeId,
      ...(body.make !== undefined ? { make: body.make } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.seatingCapacity !== undefined ? { seatingCapacity: body.seatingCapacity } : {}),
    });
    reply.send({ data: vehicle });
  }
}
