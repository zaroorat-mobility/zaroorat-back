import { driverConfig } from '@config';
import { logger } from '@shared/logger/index.js';
import {
  DriverLocationRepository,
  UpdateDriverLocationInput,
} from '../../repositories/driver-location.repository.js';
import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverStatusRepository } from '../../repositories/driver-status.repository.js';
import {
  DriverNotFoundError,
  ImplausibleLocationError,
  MockLocationRejectedError,
} from '../../errors/driver.errors.js';
import { DriverMetrics } from '../../metrics/driver.metrics.js';
import { assessPlausibility } from './location-plausibility.js';
import type { DriverLocation } from '../../types';

export class LocationService {
  constructor(
    private readonly locationRepo: DriverLocationRepository,
    private readonly driverRepo: DriverRepository,
    private readonly statusRepo: DriverStatusRepository,
    private readonly driverMetrics: DriverMetrics,
  ) {}

  async updateLocation(input: UpdateDriverLocationInput): Promise<DriverLocation> {
    if (input.isMockLocation === true && driverConfig.rejectMockLocation) {
      this.driverMetrics.mockLocationRejected({ driverId: input.driverId });
      throw new MockLocationRejectedError();
    }

    const driver = await this.driverRepo.findById(input.driverId);
    if (!driver) throw new DriverNotFoundError(input.driverId);

    const previous = await this.locationRepo.getLocation(input.driverId);
    const verdict = assessPlausibility(
      { latitude: input.latitude, longitude: input.longitude },
      previous
        ? {
            latitude: Number(previous.latitude),
            longitude: Number(previous.longitude),
            recordedAt: previous.recordedAt,
          }
        : null,
    );

    if (!verdict.plausible) {
      this.driverMetrics.implausibleLocationRejected({
        driverId: input.driverId,
        reason: verdict.reason,
      });
      logger.warn(
        { driverId: input.driverId, reason: verdict.reason, detail: verdict.detail },
        '[drivers] implausible location rejected',
      );
      throw new ImplausibleLocationError(verdict.reason, verdict.detail);
    }

    const location = await this.locationRepo.updateLocation(input);
    this.driverMetrics.locationUpdated({ driverId: input.driverId });

    await this.statusRepo.updateHeartbeat(input.driverId);

    return location;
  }

  async getLocation(driverId: string): Promise<DriverLocation | null> {
    return this.locationRepo.getLocation(driverId);
  }
}
