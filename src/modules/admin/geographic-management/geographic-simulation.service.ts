import type { DropDecision, GeographicCoverageService, PickupDecision } from '@modules/location';
import type { PricingRuleRepository } from '@modules/pricing/repositories/pricing-rule.repository.js';
import type { SurgeService } from '@modules/pricing/services/surge.service.js';

export interface SimulationInput {
  lat: number;
  lng: number;
  dropLat?: number | undefined;
  dropLng?: number | undefined;
  vehicleTypeId?: string | undefined;
  at?: Date | undefined;
}

export interface SimulationDto {
  city: { code: string; name: string; coverageMode: string } | null;
  pickup: Pick<PickupDecision, 'allowed' | 'refusal' | 'message'>;
  drop: DropDecision | null;
  vehicle: { allowed: boolean; refusal: 'VEHICLE_NOT_SUPPORTED_IN_ZONE' | null } | null;
  zones: Array<{
    code: string;
    name: string;
    zoneType: string;
    allowsPickup: boolean;
    allowsDropoff: boolean;
  }>;
  fare?: {
    ruleId: string | null;
    scope: 'ZONE' | 'CITY' | 'GLOBAL' | 'DEFAULT';
    baseFare: number | null;
    perKmRate: number | null;
    minimumFare: number | null;
  };
  surge?: { multiplier: number };
}

/// "What happens if a rider asks for a ride here?" for the admin test tool. It holds
/// no rules of its own, only calling what booking calls, so it cannot give a different
/// answer from a real quote.
export class GeographicSimulationService {
  constructor(
    private readonly geographicCoverageService: GeographicCoverageService,
    private readonly pricingRuleRepository: PricingRuleRepository,
    private readonly surgeService: SurgeService,
  ) {}

  async simulate(input: SimulationInput, includePricing: boolean): Promise<SimulationDto> {
    const decision = await this.geographicCoverageService.evaluatePickup(input.lat, input.lng);
    const { city } = decision;

    const drop =
      city && input.dropLat !== undefined && input.dropLng !== undefined
        ? await this.geographicCoverageService.evaluateDrop({
            lat: input.dropLat,
            lng: input.dropLng,
            cityCode: city.code,
          })
        : null;

    let vehicle: SimulationDto['vehicle'] = null;
    if (city && decision.allowed && input.vehicleTypeId) {
      const allowed = await this.geographicCoverageService.isVehicleTypeAllowed(
        decision.zones,
        input.vehicleTypeId,
      );
      vehicle = { allowed, refusal: allowed ? null : 'VEHICLE_NOT_SUPPORTED_IN_ZONE' };
    }

    const result: SimulationDto = {
      city: city ? { code: city.code, name: city.name, coverageMode: city.coverageMode } : null,
      pickup: { allowed: decision.allowed, refusal: decision.refusal, message: decision.message },
      drop,
      vehicle,
      zones: decision.zones.map((zone) => ({
        code: zone.code,
        name: zone.name,
        zoneType: zone.zoneType,
        allowsPickup: zone.allowsPickup,
        allowsDropoff: zone.allowsDropoff,
      })),
    };

    if (includePricing && city && input.vehicleTypeId) {
      const rule = await this.pricingRuleRepository.findBestActiveRule({
        vehicleTypeId: input.vehicleTypeId,
        cityCode: city.code,
        pickupLat: input.lat,
        pickupLng: input.lng,
      });
      result.fare = {
        ruleId: rule?.id ?? null,
        scope: !rule
          ? 'DEFAULT'
          : rule.serviceZoneId
            ? 'ZONE'
            : rule.cityCode === 'GLOBAL'
              ? 'GLOBAL'
              : 'CITY',
        baseFare: rule ? Number(rule.baseFare) : null,
        perKmRate: rule ? Number(rule.perKmRate) : null,
        minimumFare: rule ? Number(rule.minimumFare) : null,
      };
      result.surge = {
        multiplier: await this.surgeService.resolveSurgeMultiplier(
          input.lat,
          input.lng,
          input.vehicleTypeId,
          {
            timeZone: city.timezone,
            cityCode: city.code,
            maxMultiplier: city.maxSurgeMultiplier,
            at: input.at,
          },
        ),
      };
    }
    return result;
  }
}
