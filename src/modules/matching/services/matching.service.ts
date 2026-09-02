import { DatabaseService } from '@core/database';
import { GeoService } from '@modules/location';
import { VehicleEligibilityService } from '@modules/vehicles/services/vehicle-eligibility.service.js';
export interface MatchCandidate {
  driverId: string;
  distanceMeters: number;
}
/// The candidate-selection half of dispatch, shared by the first attempt
/// (`RideRequestedConsumer`, on ride.requested), every retry attempt
/// (`DispatchTimeoutJob`, on a timed-out offer) and an explicit driver
/// rejection, so "who's eligible" is defined in exactly one place regardless of
/// which round is asking.
export class MatchingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly geoService: GeoService,
    private readonly vehicleEligibilityService: VehicleEligibilityService,
  ) {}
  /// Returns up to `limit` eligible drivers, nearest first, so one dispatch
  /// round can offer the same request to several drivers at once.
  ///
  /// Eligibility is split in two on purpose. The cheap half — verified, not
  /// suspended, ONLINE, not already on a ride, holding an active assignment for
  /// an active and verified vehicle — is one indexed query over the ids geo
  /// already returned, replacing the two-queries-per-candidate loop this used to
  /// run. The expensive half (vehicle documents) is delegated to
  /// `VehicleEligibilityService`, the same implementation the go-online gate and
  /// ride acceptance use, so the three cannot drift apart.
  async findEligibleCandidates(
    origin: { latitude: number; longitude: number },
    excludeDriverIds: readonly string[],
    limit: number,
    vehicleTypeId?: string,
    radiusMeters?: number,
  ): Promise<MatchCandidate[]> {
    if (limit <= 0) return [];
    // Dispatch owns the retry policy and hands the radius down; omitting it
    // falls back to the geo default, which is what every other caller wants.
    const nearby = await this.geoService.findNearbyDrivers({
      origin,
      ...(radiusMeters !== undefined ? { radiusMeters } : {}),
    });
    if (nearby.outcome === 'no-live-candidates') return [];
    const excluded = new Set(excludeDriverIds);
    // Geo already ordered these by distance; preserve that ordering all the way
    // through, because it is the only ranking dispatch has.
    const ranked = nearby.drivers.filter((driver) => !excluded.has(driver.driverId));
    if (ranked.length === 0) return [];
    const operable = await this.operableDriverIds(
      ranked.map((driver) => driver.driverId),
      vehicleTypeId,
    );
    const candidates: MatchCandidate[] = [];
    for (const driver of ranked) {
      if (candidates.length >= limit) break;
      if (!operable.has(driver.driverId)) continue;
      // ponytail: one document check per surviving candidate, short-circuited at
      // `limit` — so it costs `limit` queries per round, not one per nearby
      // driver. Fold it into the SQL above if batch sizes ever grow large.
      const eligibility = await this.vehicleEligibilityService.check(driver.driverId);
      if (!eligibility.eligible) continue;
      candidates.push({ driverId: driver.driverId, distanceMeters: driver.distanceMeters });
    }
    return candidates;
  }
  /// Everything dispatch can ask the database in one round trip. `rides` is
  /// checked here as well as `DriverOnlineStatus` because the two can disagree:
  /// a status row is written by the application, an active ride row is the fact.
  private async operableDriverIds(
    driverIds: readonly string[],
    vehicleTypeId?: string,
  ): Promise<Set<string>> {
    if (driverIds.length === 0) return new Set();
    const rows = await this.db.client.driver.findMany({
      where: {
        id: { in: [...driverIds] },
        verificationStatus: 'VERIFIED',
        isSuspended: false,
        deletedAt: null,
        onlineStatus: { status: 'ONLINE' },
        rides: {
          none: {
            status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
          },
        },
        assignments: {
          some: {
            status: 'ACTIVE',
            vehicle: {
              isActive: true,
              verificationStatus: 'VERIFIED',
              // Category is part of being eligible for *this* request, not just
              // for driving. Accepting already refuses a mismatched vehicle
              // (`LifecycleService.assertVehicleEligible`), so offering one is a
              // slot spent on an offer that could only ever be declined.
              ...(vehicleTypeId !== undefined ? { vehicleTypeId } : {}),
            },
          },
        },
      },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }
}
