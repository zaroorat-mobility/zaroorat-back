import { RideRepository } from '@modules/rides/repositories/ride.repository.js';
import { room } from './events.js';
import { RoomAccessDeniedError } from './realtime.errors.js';
import type { SocketPrincipal } from './socket-auth.service.js';

/// The server decides room membership. A client asks to join a ride; it never
/// says which ride room it is *in*, and the answer is always re-derived from the
/// ride row rather than from anything the client sent.
export class RoomAuthorizationService {
  constructor(private readonly rideRepository: RideRepository) {}

  /// The rooms a principal is entitled to the moment it connects, with no
  /// request from the client at all: its own user room, and its driver room if
  /// it holds an operable driver identity. Both are keyed off ids the server
  /// resolved from the token.
  identityRooms(principal: SocketPrincipal): string[] {
    const rooms = [room.user(principal.userId)];
    if (principal.driverId) rooms.push(room.driver(principal.driverId));
    return rooms;
  }

  /// Ride-room membership. Exactly two principals may listen to a ride: the
  /// customer who booked it and the driver assigned to it. Anyone else — another
  /// customer, an unassigned driver, a driver who lost the offer — is refused,
  /// which is what stops a client subscribing to a stranger's trip and its
  /// driver's live position.
  async assertCanJoinRide(principal: SocketPrincipal, rideId: string): Promise<string> {
    const ride = await this.rideRepository.findById(rideId);
    // A missing ride and an unauthorised ride return the same error on purpose:
    // distinguishing them turns the room API into a probe for valid ride ids.
    if (!ride) throw new RoomAccessDeniedError(room.ride(rideId));

    const isCustomer = ride.customerId === principal.userId;
    const isAssignedDriver = principal.driverId !== null && ride.driverId === principal.driverId;
    if (!isCustomer && !isAssignedDriver) {
      throw new RoomAccessDeniedError(room.ride(rideId));
    }
    return room.ride(rideId);
  }

  /// Whether this principal is the driver currently assigned to the ride —
  /// the check behind publishing a location into a ride room.
  async isAssignedDriver(principal: SocketPrincipal, rideId: string): Promise<boolean> {
    if (!principal.driverId) return false;
    const ride = await this.rideRepository.findById(rideId);
    return ride?.driverId === principal.driverId;
  }
}
