import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StatusService } from '../../../src/modules/drivers/services/status/status.service.js';
import {
  DriverNotVerifiedError,
  DriverSuspendedError,
} from '../../../src/modules/drivers/errors/driver.errors.js';

describe('Driver Operational Verification Gate Tests', () => {
  it('prevents an unverified driver from going ONLINE', async () => {
    const mockDriverRepo = {
      lockForUpdate: async () => ({
        id: 'driver-1',
        verificationStatus: 'PENDING',
        isSuspended: false,
      }),
    };

    const service = new StatusService(
      mockDriverRepo as never,
      {} as never,
      {} as never,
      {} as never,
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

    const service = new StatusService(
      mockDriverRepo as never,
      {} as never,
      {} as never,
      {} as never,
      { execute: async (cb: (tx: unknown) => unknown) => cb({}) } as never,
      {} as never,
      { driverOnline: () => {} } as never,
      {} as never,
    );

    await assert.rejects(async () => service.setOnline('driver-2'), DriverSuspendedError);
  });
});
