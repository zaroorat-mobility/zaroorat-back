import { DatabaseService } from '@core/database';
import { PricingService, SurgeService } from '@modules/pricing';
import { PricingRuleRepository } from '@modules/pricing/repositories/pricing-rule.repository.js';
import { VehicleTypeService } from '@modules/vehicles/services/vehicle-type.service.js';
import { parseServiceType } from '../service-zone/service-zone.service.js';
import type { SimulatePricingBody } from './simulate.schemas.js';

export class AdminPricingSimulateService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly pricingRuleRepository: PricingRuleRepository,
    private readonly pricingService: PricingService,
    private readonly surgeService: SurgeService,
    private readonly vehicleTypeService: VehicleTypeService,
  ) {}

  async simulate(body: SimulatePricingBody) {
    const vehicleType = await this.vehicleTypeService.resolveForConfig({
      id: body.vehicleTypeId,
      code: body.vehicleType,
    });
    const cityCode = body.cityCode || 'GLOBAL';
    const serviceType = parseServiceType(body.serviceType ?? null) ?? undefined;
    const at = body.at ? new Date(body.at) : new Date();

    const matchedRule = await this.pricingRuleRepository.findBestActiveRule({
      vehicleTypeId: vehicleType.id,
      cityCode,
      ...(serviceType ? { serviceType } : {}),
      ...(body.serviceZoneId ? { serviceZoneId: body.serviceZoneId } : {}),
      ...(body.pickupLat !== undefined ? { pickupLat: body.pickupLat } : {}),
      ...(body.pickupLng !== undefined ? { pickupLng: body.pickupLng } : {}),
      at,
    });

    const card = this.pricingService.rateCardFor(matchedRule);

    let surgeMultiplier = 1;
    let surgeSource: 'override' | 'live' | 'default' = 'default';
    if (body.surgeMultiplier !== undefined) {
      surgeMultiplier = body.surgeMultiplier;
      surgeSource = 'override';
    } else if (body.pickupLat !== undefined && body.pickupLng !== undefined) {
      const city =
        cityCode !== 'GLOBAL'
          ? await this.databaseService.client.city.findFirst({
              where: { code: cityCode },
              select: { timezone: true, maxSurgeMultiplier: true },
            })
          : null;
      surgeMultiplier = await this.surgeService.resolveSurgeMultiplier(
        body.pickupLat,
        body.pickupLng,
        vehicleType.id,
        {
          ...(city?.timezone ? { timeZone: city.timezone } : {}),
          ...(cityCode !== 'GLOBAL' ? { cityCode } : {}),
          ...(city?.maxSurgeMultiplier != null
            ? { maxMultiplier: Number(city.maxSurgeMultiplier) }
            : {}),
        },
      );
      surgeSource = 'live';
    }

    const fare = await this.pricingService.calculateFinalFare({
      actualDistanceKm: body.distanceKm,
      actualDurationMin: body.durationMin,
      vehicleTypeId: vehicleType.id,
      rateCard: card,
      surgeMultiplier,
      waitingMinutes: body.waitingMinutes,
      discountAmount: body.discountAmount,
    });

    const atAcceptance = await this.pricingService.calculateFinalFare({
      actualDistanceKm: body.distanceKm,
      actualDurationMin: body.durationMin,
      vehicleTypeId: vehicleType.id,
      rateCard: card,
    });

    return {
      simulatedAt: at.toISOString(),
      vehicleType: {
        id: vehicleType.id,
        code: vehicleType.code,
        name: vehicleType.name,
      },
      cityCode,
      resolvedRule: matchedRule
        ? {
            source: 'rule' as const,
            id: matchedRule.id,
            version: matchedRule.version,
            ruleFamilyId: matchedRule.ruleFamilyId ?? matchedRule.id,
            cityCode: matchedRule.cityCode,
            serviceZoneId: matchedRule.serviceZoneId,
            effectiveFrom: matchedRule.effectiveFrom.toISOString(),
            effectiveTo: matchedRule.effectiveTo?.toISOString() ?? null,
          }
        : {
            source: 'platform_default' as const,
            id: null,
            version: null,
            ruleFamilyId: null,
            cityCode: 'GLOBAL',
            serviceZoneId: null,
            effectiveFrom: null,
            effectiveTo: null,
          },
      surge: {
        multiplier: fare.surgeMultiplier,
        source: surgeSource,
      },
      rates: {
        baseFare: card.baseFare,
        minimumFare: card.minimumFare,
        perKmRate: card.perKm,
        perMinuteRate: card.perMinute,
        freeWaitingMinutes: card.freeWaitingMin,
        waitingChargePerMinute: card.perWaitingMinute,
        bookingFee: card.bookingFee,
        platformFeePct: card.platformFeePct,
        platformFeeFlat: card.platformFeeFlat,
        taxRatePct: card.taxRatePct,
        commissionRatePct: card.commissionRatePct,
      },
      fare,
      commissionAtAcceptance: atAcceptance.platformCommission,
    };
  }
}
