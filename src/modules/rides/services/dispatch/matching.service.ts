import { GeoService } from '@modules/geo';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverStatusRepository } from '@modules/drivers/repositories/driver-status.repository.js';
export interface MatchCandidate {
  driverId: string;
  distanceMeters: number;
}
/// The candidate-selection half of dispatch, shared by the first attempt
/// (`RideRequestedConsumer`, on ride.requested) and every retry attempt
/// (`DispatchTimeoutJob`, on a timed-out offer) so "who's eligible" is
/// defined in exactly one place regardless of which round is asking.
export class MatchingService {
  constructor(
    private readonly geoService: GeoService,
    private readonly driverRepository: DriverRepository,
    private readonly driverStatusRepository: DriverStatusRepository,
  ) {}
  async findNextEligibleCandidate(
    origin: { latitude: number; longitude: number },
    excludeDriverIds: readonly string[],
  ): Promise<MatchCandidate | null> {
    const nearby = await this.geoService.findNearbyDrivers({ origin });
    if (nearby.outcome === 'no-live-candidates') return null;
    const excluded = new Set(excludeDriverIds);
    for (const candidate of nearby.drivers) {
      if (excluded.has(candidate.driverId)) continue;
      if (await this.isEligible(candidate.driverId)) {
        return { driverId: candidate.driverId, distanceMeters: candidate.distanceMeters };
      }
    }
    return null;
  }
  private async isEligible(driverId: string): Promise<boolean> {
    const driver = await this.driverRepository.findById(driverId);
    if (!driver || driver.verificationStatus !== 'VERIFIED' || driver.isSuspended) return false;
    const status = await this.driverStatusRepository.getStatus(driverId);
    return status?.status === 'ONLINE';
  }
}
