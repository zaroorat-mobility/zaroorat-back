import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StatusService } from '../../../src/modules/drivers/services/status/status.service.js';
import { DriverEligibilityService } from '../../../src/modules/drivers/services/eligibility/eligibility.service.js';
import {
  DriverNotVerifiedError,
  DriverSuspendedError,
} from '../../../src/modules/drivers/errors/driver.errors.js';
import { driverConfig } from '../../../src/config/driver/driver.config.js';

function makeDocRepo(
  docs: { documentType: string; verificationStatus: string; expiresAt: Date | null }[],
) {
  return {
    findByDriverId: async () => docs,
  };
}

describe('Driver Operational Verification Gate Tests', () => {
  it('prevents an unverified driver from going ONLINE', async () => {
    const mockDriverRepo = {
      lockForUpdate: async () => ({
        id: 'driver-1',
        verificationStatus: 'PENDING',
        isSuspended: false,
      }),
    };

    const eligibilityService = new DriverEligibilityService(makeDocRepo([]) as never);

    const service = new StatusService(
      mockDriverRepo as never,
      {} as never,
      {} as never,
      eligibilityService,
      { execute: async (cb: (tx: unknown) => unknown) => cb({}) } as never,
      {} as never,
      { driverOnline: () => {} } as never,
      {} as never,
    );

    await assert.rejects(async () => service.setOnline('driver-1'), DriverNotVerifiedError);
  });

  it('prevents a suspended driver from going ONLINE', async () => {
    const mockDriverRepo = {
      lockForUpdate: async () => ({
        id: 'driver-2',
        verificationStatus: 'VERIFIED',
        isSuspended: true,
      }),
    };

    const eligibilityService = new DriverEligibilityService(makeDocRepo([]) as never);

    const service = new StatusService(
      mockDriverRepo as never,
      {} as never,
      {} as never,
      eligibilityService,
      { execute: async (cb: (tx: unknown) => unknown) => cb({}) } as never,
      {} as never,
      { driverOnline: () => {} } as never,
      {} as never,
    );

    await assert.rejects(async () => service.setOnline('driver-2'), DriverSuspendedError);
  });

  it('prevents a verified driver with a missing required document from going ONLINE', async () => {
    const mockDriverRepo = {
      lockForUpdate: async () => ({
        id: 'driver-3',
        verificationStatus: 'VERIFIED',
        isSuspended: false,
      }),
    };

    const eligibilityService = new DriverEligibilityService(
      makeDocRepo([
        { documentType: 'DRIVING_LICENSE', verificationStatus: 'VERIFIED', expiresAt: null },
      ]) as never,
    );

    const service = new StatusService(
      mockDriverRepo as never,
      {} as never,
      {} as never,
      eligibilityService,
      { execute: async (cb: (tx: unknown) => unknown) => cb({}) } as never,
      {} as never,
      { driverOnline: () => {} } as never,
      {} as never,
    );

    await assert.rejects(async () => service.setOnline('driver-3'), DriverNotVerifiedError);
  });

  it('allows a verified driver with every required document VERIFIED and unexpired to go ONLINE', async () => {
    const mockDriverRepo = {
      lockForUpdate: async () => ({
        id: 'driver-4',
        verificationStatus: 'VERIFIED',
        isSuspended: false,
      }),
      updateAvailability: async () => ({}),
    };
    const mockShiftRepo = {
      startShift: async () => ({ id: 'shift-1' }),
    };
    const mockStatusRepo = {
      updateStatus: async () => ({ driverId: 'driver-4', status: 'ONLINE' }),
    };

    const docs = driverConfig.requiredDocumentTypes.map((documentType) => ({
      documentType,
      verificationStatus: 'VERIFIED',
      expiresAt: null,
    }));
    const eligibilityService = new DriverEligibilityService(makeDocRepo(docs) as never);

    const service = new StatusService(
      mockDriverRepo as never,
      mockStatusRepo as never,
      mockShiftRepo as never,
      eligibilityService,
      { execute: async (cb: (tx: unknown) => unknown) => cb({}) } as never,
      { publish: async () => {} } as never,
      { driverOnline: () => {} } as never,
      {} as never,
    );

    const result = await service.setOnline('driver-4');
    assert.equal(result.status, 'ONLINE');
  });
});
