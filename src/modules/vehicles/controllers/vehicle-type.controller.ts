import type { FastifyReply, FastifyRequest } from 'fastify';
import { VehicleTypeService } from '../services/vehicle-type.service.js';
import type { VehicleType } from '../types/index.js';

export interface VehicleTypeView {
  id: string;
  code: string;
  name: string;
  icon: string | null;
  displayOrder: number;
  passengerCapacity: number | null;
  luggageCapacity: number | null;
  baseFare: number | null;
  perKmRate: number | null;
  perMinuteRate: number | null;
  minimumFare: number | null;
  isActive: boolean;
}

/// Decimal columns are serialized as numbers rather than Prisma Decimal
/// instances, which stringify as objects through the JSON schema.
export function toVehicleTypeView(vehicleType: VehicleType): VehicleTypeView {
  return {
    id: vehicleType.id,
    code: vehicleType.code,
    name: vehicleType.name,
    icon: vehicleType.icon,
    displayOrder: vehicleType.displayOrder,
    passengerCapacity: vehicleType.passengerCapacity,
    luggageCapacity: vehicleType.luggageCapacity,
    baseFare: vehicleType.baseFare ? Number(vehicleType.baseFare) : null,
    perKmRate: vehicleType.perKmRate ? Number(vehicleType.perKmRate) : null,
    perMinuteRate: vehicleType.perMinuteRate ? Number(vehicleType.perMinuteRate) : null,
    minimumFare: vehicleType.minimumFare ? Number(vehicleType.minimumFare) : null,
    isActive: vehicleType.isActive,
  };
}

export class VehicleTypeController {
  constructor(private readonly vehicleTypeService: VehicleTypeService) {}

  /// The catalog the customer app renders its category picker from, and the
  /// only sanctioned way any client obtains a `vehicleTypeId`.
  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { cityId } = (req.query ?? {}) as { cityId?: string };
    const types = await this.vehicleTypeService.listActive(cityId !== undefined ? { cityId } : {});
    reply.send({ data: types.map(toVehicleTypeView) });
  }
}
