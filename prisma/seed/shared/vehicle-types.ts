import { ProviderClient } from '../../../src/core/database';

/**
 * The service catalog and the rate card for each category. Reference data in
 * exactly the sense the RBAC roles are: required in every environment, safe to
 * run repeatedly, and the thing every client resolves a `vehicleTypeId` from.
 *
 * `code` is the stable identifier and the upsert key; `id` is generated, so
 * nothing outside the database may hard-code it.
 *
 * ## Where the rates live, and why they are back here
 *
 * These four rate cards are this project's own, restored from the seed as it
 * stood at 3bbff1d. They were dropped by 85b32d9 ("chore: refactor admin module
 * and move pricing logic"), which moved pricing off `VehicleType` and onto
 * `PricingRule` but never wrote the rows — and nothing else ever did either:
 * there is no other writer for `pricing_rules` in the codebase, no admin
 * endpoint (the "pricing-management" module covers surge only) and no fixture.
 *
 * With the table permanently empty, `PricingService.rateCardForTypeId` found
 * nothing for any category, fell through to `rateCardFor(null)`, and returned
 * `pricingConfig.defaultRateCard` — whose numbers are CAB_ECONOMY's — for every
 * ride. A bike, an auto and a premium cab were all billed as an economy cab.
 *
 * Seeded at `cityCode: 'GLOBAL'` because that is the fallback
 * `rateCardForTypeId` already looks for when no city rule matches. A city that
 * wants its own prices gets its own rows under its `City.code`; nothing here
 * has to change for that.
 *
 * Not restored: the old `cancellationCharge` per category. `PricingRule` has no
 * column for it, and cancellation fees are assessed from
 * `rideConfig.defaultCancellationFee` and are not collected at all (see
 * `CancellationService`), so there is nothing for a per-category figure to feed
 * yet.
 */
export const VEHICLE_TYPE_SEED = [
  {
    code: 'BIKE',
    name: 'Bike',
    icon: 'bike',
    displayOrder: 10,
    passengerCapacity: 1,
    luggageCapacity: 0,
    rateCard: { baseFare: 20, perKmRate: 6, perMinuteRate: 1, waitingPerMin: 1, minimumFare: 25 },
  },
  {
    code: 'AUTO',
    name: 'Auto',
    icon: 'auto',
    displayOrder: 20,
    passengerCapacity: 3,
    luggageCapacity: 1,
    rateCard: { baseFare: 30, perKmRate: 9, perMinuteRate: 1.5, waitingPerMin: 2, minimumFare: 35 },
  },
  {
    code: 'CAB_ECONOMY',
    name: 'Cab Economy',
    icon: 'cab',
    displayOrder: 30,
    passengerCapacity: 4,
    luggageCapacity: 2,
    rateCard: { baseFare: 50, perKmRate: 12, perMinuteRate: 2, waitingPerMin: 3, minimumFare: 50 },
  },
  {
    code: 'CAB_PREMIUM',
    name: 'Cab Premium',
    icon: 'cab-premium',
    displayOrder: 40,
    passengerCapacity: 4,
    luggageCapacity: 3,
    rateCard: { baseFare: 80, perKmRate: 18, perMinuteRate: 3, waitingPerMin: 4, minimumFare: 90 },
  },
] as const;

/// The rate card every category falls back to when no city has its own.
export const GLOBAL_PRICING_CITY_CODE = 'GLOBAL';

export async function seedVehicleTypes(prisma: ProviderClient): Promise<void> {
  for (const { rateCard, ...type } of VEHICLE_TYPE_SEED) {
    const saved = await prisma.vehicleType.upsert({
      where: { code: type.code },
      create: { ...type, isActive: true },
      // Presentation is re-applied on every run so a catalog change ships with
      // the seed; `isActive` is deliberately NOT reset, so a type an operator
      // retired stays retired.
      update: {
        name: type.name,
        icon: type.icon,
        displayOrder: type.displayOrder,
        passengerCapacity: type.passengerCapacity,
        luggageCapacity: type.luggageCapacity,
      },
    });

    // `pricing_rules` has only an index on [cityCode, vehicleTypeId], not a
    // unique constraint, so there is no `upsert` to reach for — and adding one
    // would be a migration for a seed's convenience. Find-then-write keeps this
    // re-runnable, which is the property that actually matters.
    const existing = await prisma.pricingRule.findFirst({
      where: { vehicleTypeId: saved.id, cityCode: GLOBAL_PRICING_CITY_CODE },
    });
    if (existing) {
      await prisma.pricingRule.update({ where: { id: existing.id }, data: rateCard });
    } else {
      await prisma.pricingRule.create({
        data: { ...rateCard, vehicleTypeId: saved.id, cityCode: GLOBAL_PRICING_CITY_CODE },
      });
    }
  }
}
