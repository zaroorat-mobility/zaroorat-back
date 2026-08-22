import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverNotFoundError } from '@modules/drivers/errors/driver.errors.js';
import {
  VehicleAssignmentService,
  type DriverEditableVehicleInput,
} from '../services/vehicle-assignment.service.js';
import { claimVehicleSchema, updateVehicleSchema } from '../schemas/vehicle.schemas.js';
import { toVehicleTypeView } from './vehicle-type.controller.js';
import type { Vehicle, VehicleDocument, VehicleType } from '../types/index.js';

type VehicleWithRelations = Vehicle & {
  vehicleType?: VehicleType | null;
  documents?: VehicleDocument[];
};

export function toVehicleView(vehicle: VehicleWithRelations): Record<string, unknown> {
  return {
    id: vehicle.id,
    registrationNumber: vehicle.registrationNumber,
    registrationState: vehicle.registrationState,
    vehicleTypeId: vehicle.vehicleTypeId,
    vehicleType: vehicle.vehicleType ? toVehicleTypeView(vehicle.vehicleType) : null,
    make: vehicle.make,
    model: vehicle.model,
    color: vehicle.color,
    fuelType: vehicle.fuelType,
    manufacturingYear: vehicle.manufacturingYear,
    seatingCapacity: vehicle.seatingCapacity,
    currentDriverId: vehicle.currentDriverId,
    verificationStatus: vehicle.verificationStatus,
    rejectionReason: vehicle.rejectionReason,
    verifiedAt: vehicle.verifiedAt,
    isActive: vehicle.isActive,
    ...(vehicle.documents ? { documents: vehicle.documents } : {}),
  };
}

export class VehicleController {
  constructor(
    private readonly vehicleAssignmentService: VehicleAssignmentService,
    private readonly driverRepository: DriverRepository,
  ) {}

  /// Every driver-scoped vehicle route resolves the acting driver from the
  /// token, never from the path — the same rule `actingDriverId` enforces in
  /// the drivers module.
  private async actingDriverId(req: FastifyRequest): Promise<string> {
    const userId = callerId(req);
    const driver = await this.driverRepository.findByUserId(userId);
    if (!driver) throw new DriverNotFoundError(userId);
    return driver.id;
  }

  async claim(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const body = claimVehicleSchema.parse(req.body);
    const vehicle = await this.vehicleAssignmentService.claimVehicle({
      driverId,
      registrationNumber: body.registrationNumber,
      vehicleTypeId: body.vehicleTypeId,
      ...(body.make !== undefined ? { make: body.make } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.seatingCapacity !== undefined ? { seatingCapacity: body.seatingCapacity } : {}),
    });
    reply.send({ data: toVehicleView(vehicle) });
  }

  /// Returns `null`, not 404, when the driver has not claimed a vehicle yet:
  /// "no vehicle" is a normal onboarding state, not a missing resource.
  async getMine(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const vehicle = await this.vehicleAssignmentService.findMyVehicle(driverId);
    reply.send({ data: vehicle ? toVehicleView(vehicle) : null });
  }

  async update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as { id: string };
    const body = updateVehicleSchema.parse(req.body ?? {});
    // `exactOptionalPropertyTypes` distinguishes "absent" from "present and
    // undefined"; Zod's output carries the latter for every optional it did not
    // see, so the keys are dropped rather than forwarded as undefined.
    const changes = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    ) as DriverEditableVehicleInput;
    const vehicle = await this.vehicleAssignmentService.updateVehicle(id, driverId, changes);
    reply.send({ data: toVehicleView(vehicle) });
  }

  async release(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    await this.vehicleAssignmentService.releaseVehicle(driverId);
    reply.status(204).send();
  }
}
