import type { Ride } from './ride.types.js';

/// The two user ids a ride belongs to.
///
/// `RideRepository.findById` selects `driver: { userId: true }`, but the
/// generated `Ride` type does not declare the relation, so every caller that
/// wanted the driver's user id wrote the same inline cast. Four copies of it
/// existed; this is that cast, once.
///
/// Only `findById` includes the relation — a `Ride` from any other query
/// reports a null driver here, which is why `rideParty` treats null as "not the
/// driver" rather than as a match.
export function ridePartyIds(ride: Ride): { customerId: string; driverUserId: string | null } {
  return {
    customerId: ride.customerId,
    driverUserId: (ride as { driver?: { userId?: string } }).driver?.userId ?? null,
  };
}

/// Which side of a ride a user is on — read from the ride, never from their
/// roles.
///
/// Roles cannot answer this. `ensureDefaultRole` grants `customer` to every
/// phone login, and a verified driver keeps `driver` for good, so an off-duty
/// driver taking a ride as a passenger holds both. Three call sites used
/// `callerHasRole(req, 'driver')` as the discriminator and therefore treated
/// that passenger as the ride's driver: they could not cancel their own ride
/// (403 RIDE_DRIVER_MISMATCH), could not see it under `/rides/active`, and
/// could not rate it.
export function rideParty(userId: string, ride: Ride): 'CUSTOMER' | 'DRIVER' | null {
  const parties = ridePartyIds(ride);
  // Customer first: after `SelfRideNotAllowedError` a user cannot be both, and
  // if that guard were ever bypassed the passenger reading is the safer one.
  if (parties.customerId === userId) return 'CUSTOMER';
  if (parties.driverUserId !== null && parties.driverUserId === userId) return 'DRIVER';
  return null;
}
