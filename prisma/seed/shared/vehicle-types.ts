import { ProviderClient } from '../../../src/core/database';

/**
 * The service catalog. Reference data in exactly the sense the RBAC roles are:
 * required in every environment, safe to run repeatedly, and the thing every
 * client resolves a `vehicleTypeId` from.
 *
 * Pricing lives on these rows rather than in environment variables — the
 * previous `RIDE_RATE_CARDS_JSON` knob was keyed by database-generated UUID and
 * so could never be populated by an operator. Any field left null here falls
 * back to `rideConfig.defaultRateCard` in `FareService.rateCardFor`.
 *
 * `code` is the stable identifier and the upsert key; `id` is generated, so
 * nothing outside the database may hard-code it.
 */
export const VEHICLE_TYPE_SEED = [
  {
    code: 'BIKE',
    name: 'Bike',
    icon: 'bike',
    displayOrder: 10,
    passengerCapacity: 1,
    luggageCapacity: 0,
    baseFare: 20,
    perKmRate: 6,
    perMinuteRate: 1,
    waitingCharge: 1,
    minimumFare: 25,
    cancellationCharge: 15,
  },
  {
    code: 'AUTO',
    name: 'Auto',
    icon: 'auto',
    displayOrder: 20,
    passengerCapacity: 3,
    luggageCapacity: 1,
    baseFare: 30,
    perKmRate: 9,
    perMinuteRate: 1.5,
    waitingCharge: 2,
    minimumFare: 35,
    cancellationCharge: 25,
  },
  {
    code: 'CAB_ECONOMY',
    name: 'Cab Economy',
    icon: 'cab',
    displayOrder: 30,
    passengerCapacity: 4,
    luggageCapacity: 2,
    baseFare: 50,
    perKmRate: 12,
    perMinuteRate: 2,
    waitingCharge: 3,
    minimumFare: 50,
    cancellationCharge: 40,
  },
  {
    code: 'CAB_PREMIUM',
    name: 'Cab Premium',
    icon: 'cab-premium',
    displayOrder: 40,
    passengerCapacity: 4,
    luggageCapacity: 3,
    baseFare: 80,
    perKmRate: 18,
    perMinuteRate: 3,
    waitingCharge: 4,
    minimumFare: 90,
    cancellationCharge: 60,
  },
] as const;

export async function seedVehicleTypes(prisma: ProviderClient): Promise<void> {
  for (const type of VEHICLE_TYPE_SEED) {
    await prisma.vehicleType.upsert({
      where: { code: type.code },
      create: { ...type, isActive: true },
      // Pricing and presentation are re-applied on every run so a rate change
      // ships with the seed; `isActive` is deliberately NOT reset, so a type an
      // operator retired stays retired.
      update: {
        name: type.name,
        icon: type.icon,
        displayOrder: type.displayOrder,
        passengerCapacity: type.passengerCapacity,
        luggageCapacity: type.luggageCapacity,
        baseFare: type.baseFare,
        perKmRate: type.perKmRate,
        perMinuteRate: type.perMinuteRate,
        waitingCharge: type.waitingCharge,
        minimumFare: type.minimumFare,
        cancellationCharge: type.cancellationCharge,
      },
    });
  }
}
