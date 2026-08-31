import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PricingRateCard } from '@config';
import { PricingService } from '@modules/pricing';
import { GeographicCoverageService } from '@modules/location';
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
///
/// `rateCard` is optional only because the two callers get it differently — the
/// catalog batches one lookup for every category, the quote already holds the
/// card it priced with. Omitting it leaves the four fare fields null, which the
/// published response schema allows.
export function toVehicleTypeView(
  vehicleType: VehicleType,
  rateCard?: PricingRateCard,
): VehicleTypeView {
  return {
    id: vehicleType.id,
    code: vehicleType.code,
    name: vehicleType.name,
    icon: vehicleType.icon,
    displayOrder: vehicleType.displayOrder,
    passengerCapacity: vehicleType.passengerCapacity,
    luggageCapacity: vehicleType.luggageCapacity,
    baseFare: rateCard?.baseFare ?? null,
    perKmRate: rateCard?.perKm ?? null,
    perMinuteRate: rateCard?.perMinute ?? null,
    minimumFare: rateCard?.minimumFare ?? null,
    isActive: vehicleType.isActive,
  };
}

export class VehicleTypeController {
  constructor(
    private readonly vehicleTypeService: VehicleTypeService,
    private readonly pricingService: PricingService,
    private readonly geographicCoverageService: GeographicCoverageService,
  ) {}

  /// The catalog the customer app renders its category picker from, and the
  /// only sanctioned way any client obtains a `vehicleTypeId`.
  ///
  /// The fare fields have been in this endpoint's published response schema all
  /// along and were never populated: pricing moved from `VehicleType` onto
  /// `PricingRule` and the view was not moved with it, so `/docs` advertised a
  /// `perKmRate` that every response omitted.
  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { cityId, lat, lng } = (req.query ?? {}) as {
      cityId?: string;
      lat?: number;
      lng?: number;
    };
    const types = await this.vehicleTypeService.listActive(cityId !== undefined ? { cityId } : {});

    // FR-041 / BD-9. With a pickup point the catalog resolves exactly what the
    // quote will: the city that owns the point, then that city's zone rules.
    // Without one it can only reach the GLOBAL card, which is what advertised a
    // price the quote did not charge — so it publishes no rate figure instead.
    if (lat === undefined || lng === undefined) {
      reply.send({ data: types.map((type) => toVehicleTypeView(type)) });
      return;
    }

    const city = await this.geographicCoverageService.resolveCityAtPoint(lat, lng);
    const rateCards = await this.pricingService.rateCardsForPoint({
      vehicleTypeIds: types.map((type) => type.id),
      ...(city?.code !== undefined ? { cityCode: city.code } : {}),
      pickupLat: lat,
      pickupLng: lng,
    });
    reply.send({ data: types.map((type) => toVehicleTypeView(type, rateCards.get(type.id))) });
  }
}
