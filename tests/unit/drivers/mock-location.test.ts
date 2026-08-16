import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocationService } from '../../../src/modules/drivers/services/location/location.service.js';
import { MockLocationRejectedError } from '../../../src/modules/drivers/errors/driver.errors.js';

describe('Mock Location Spoofing Rejection Tests', () => {
  it('rejects GPS location updates flagged with isMockLocation = true', async () => {
    const service = new LocationService(
      {} as never,
      {} as never,
      {} as never,
      { mockLocationRejected: () => {} } as never,
      {} as never,
    );

    await assert.rejects(
      async () =>
        service.updateLocation({
          driverId: 'driver-1',
          latitude: 28.6139,
          longitude: 77.209,
          isMockLocation: true,
        }),
      MockLocationRejectedError,
    );
  });
});
