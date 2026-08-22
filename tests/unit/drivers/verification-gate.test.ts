import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StatusService } from '../../../src/modules/drivers/services/status/status.service.js';
import { DriverEligibilityService } from '../../../src/modules/drivers/services/eligibility/eligibility.service.js';
import { VehicleEligibilityService } from '../../../src/modules/vehicles/services/vehicle-eligibility.service.js';
import {
  DriverNotVerifiedError,
  DriverSuspendedError,
} from '../../../src/modules/drivers/errors/driver.errors.js';
import {
  NoActiveVehicleError,
  VehicleDocumentsIncompleteError,
  VehicleInactiveError,
  VehicleNotVerifiedError,
} from '../../../src/modules/vehicles/errors/vehicle.errors.js';
import { driverConfig } from '../../../src/config/driver/driver.config.js';
import { vehicleConfig } from '../../../src/config/vehicle/vehicle.config.js';

function makeDocRepo(
  docs: { documentType: string; verificationStatus: string; expiresAt: Date | null }[],
) {
  return {
    findByDriverId: async () => docs,
  };
}

interface VehicleWorld {
  vehicle?: {
    id?: string;
    isActive?: boolean;
    verificationStatus?: string;
  } | null;
  assigned?: boolean;
  documents?: { documentType: string; verificationStatus: string; expiresAt: Date | null }[];
}

/// A vehicle gate that passes by default, so a test only spells out the one
/// condition it is actually about.
function makeVehicleEligibility(world: VehicleWorld = {}): VehicleEligibilityService {
  const vehicle =
    world.vehicle === null
      ? null
      : {
          id: 'vehicle-1',
          isActive: true,
          verificationStatus: 'VERIFIED',
          ...world.vehicle,
        };
  const documents =
    world.documents ??
    vehicleConfig.requiredDocumentTypes.map((documentType) => ({
      documentType,
      verificationStatus: 'VERIFIED',
      expiresAt: null,
    }));

  return new VehicleEligibilityService(
    { findById: async () => vehicle } as never,
    {
      findActiveForDriver: async () =>
        world.assigned === false || vehicle === null
          ? null
          : { driverId: 'd', vehicleId: vehicle.id, status: 'ACTIVE' },
    } as never,
    { findByVehicleId: async () => documents } as never,
  );
}

function makeStatusService(options: {
  driverRepo: unknown;
  eligibilityService: DriverEligibilityService;
  vehicleEligibilityService?: VehicleEligibilityService;
  statusRepo?: unknown;
  shiftRepo?: unknown;
  eventPublisher?: unknown;
}): StatusService {
  return new StatusService(
    options.driverRepo as never,
    (options.statusRepo ?? {}) as never,
    (options.shiftRepo ?? {}) as never,
    options.eligibilityService,
    options.vehicleEligibilityService ?? makeVehicleEligibility(),
    { execute: async (cb: (tx: unknown) => unknown) => cb({}) } as never,
    (options.eventPublisher ?? {}) as never,
    { driverOnline: () => {} } as never,
    {} as never,
  );
}

function verifiedDriverRepo(id: string) {
  return {
    lockForUpdate: async () => ({ id, verificationStatus: 'VERIFIED', isSuspended: false }),
    updateAvailability: async () => ({}),
  };
}

const allDriverDocs = () =>
  driverConfig.requiredDocumentTypes.map((documentType) => ({
    documentType,
    verificationStatus: 'VERIFIED',
    expiresAt: null,
  }));

describe('Driver Operational Verification Gate Tests', () => {
  it('prevents an unverified driver from going ONLINE', async () => {
    const service = makeStatusService({
      driverRepo: {
        lockForUpdate: async () => ({
          id: 'driver-1',
          verificationStatus: 'PENDING',
          isSuspended: false,
        }),
      },
      eligibilityService: new DriverEligibilityService(makeDocRepo([]) as never),
    });

    await assert.rejects(async () => service.setOnline('driver-1'), DriverNotVerifiedError);
  });

  it('prevents a suspended driver from going ONLINE', async () => {
    const service = makeStatusService({
      driverRepo: {
        lockForUpdate: async () => ({
          id: 'driver-2',
          verificationStatus: 'VERIFIED',
          isSuspended: true,
        }),
      },
      eligibilityService: new DriverEligibilityService(makeDocRepo([]) as never),
    });

    await assert.rejects(async () => service.setOnline('driver-2'), DriverSuspendedError);
  });

  it('prevents a verified driver with a missing required document from going ONLINE', async () => {
    const service = makeStatusService({
      driverRepo: verifiedDriverRepo('driver-3'),
      eligibilityService: new DriverEligibilityService(
        makeDocRepo([
          { documentType: 'DRIVING_LICENSE', verificationStatus: 'VERIFIED', expiresAt: null },
        ]) as never,
      ),
    });

    await assert.rejects(async () => service.setOnline('driver-3'), DriverNotVerifiedError);
  });

  it('allows a verified driver with every required document VERIFIED and unexpired to go ONLINE', async () => {
    const service = makeStatusService({
      driverRepo: verifiedDriverRepo('driver-4'),
      statusRepo: { updateStatus: async () => ({ driverId: 'driver-4', status: 'ONLINE' }) },
      shiftRepo: { startShift: async () => ({ id: 'shift-1' }) },
      eventPublisher: { publish: async () => {} },
      eligibilityService: new DriverEligibilityService(makeDocRepo(allDriverDocs()) as never),
    });

    const result = await service.setOnline('driver-4');
    assert.equal(result.status, 'ONLINE');
  });
});

/// The vehicle half of the gate. Each case leaves the driver fully eligible so
/// the failure can only come from the vehicle, and each asserts a *distinct*
/// error type — the whole point of the separate codes is that a driver app can
/// tell "no vehicle" from "awaiting review" from "papers incomplete".
describe('Vehicle eligibility gate on going ONLINE', () => {
  function serviceWith(world: VehicleWorld): StatusService {
    return makeStatusService({
      driverRepo: verifiedDriverRepo('driver-v'),
      statusRepo: { updateStatus: async () => ({ driverId: 'driver-v', status: 'ONLINE' }) },
      shiftRepo: { startShift: async () => ({ id: 'shift-1' }) },
      eventPublisher: { publish: async () => {} },
      eligibilityService: new DriverEligibilityService(makeDocRepo(allDriverDocs()) as never),
      vehicleEligibilityService: makeVehicleEligibility(world),
    });
  }

  it('refuses a driver with no vehicle assigned', async () => {
    await assert.rejects(
      async () => serviceWith({ assigned: false }).setOnline('driver-v'),
      NoActiveVehicleError,
    );
  });

  it('refuses a driver whose vehicle is not active', async () => {
    await assert.rejects(
      async () => serviceWith({ vehicle: { isActive: false } }).setOnline('driver-v'),
      VehicleInactiveError,
    );
  });

  it('refuses a driver whose vehicle has not been verified', async () => {
    await assert.rejects(
      async () => serviceWith({ vehicle: { verificationStatus: 'PENDING' } }).setOnline('driver-v'),
      VehicleNotVerifiedError,
    );
  });

  it('refuses a driver whose vehicle was rejected', async () => {
    await assert.rejects(
      async () =>
        serviceWith({ vehicle: { verificationStatus: 'REJECTED' } }).setOnline('driver-v'),
      VehicleNotVerifiedError,
    );
  });

  it('refuses a driver whose vehicle is missing a required document', async () => {
    await assert.rejects(
      async () => serviceWith({ documents: [] }).setOnline('driver-v'),
      VehicleDocumentsIncompleteError,
    );
  });

  it('refuses a driver whose vehicle document has expired', async () => {
    const expired = vehicleConfig.requiredDocumentTypes.map((documentType) => ({
      documentType,
      verificationStatus: 'VERIFIED',
      expiresAt: new Date(Date.now() - 86_400_000),
    }));
    await assert.rejects(
      async () => serviceWith({ documents: expired }).setOnline('driver-v'),
      VehicleDocumentsIncompleteError,
    );
  });

  it('allows a driver whose vehicle is active, verified and fully documented', async () => {
    const result = await serviceWith({}).setOnline('driver-v');
    assert.equal(result.status, 'ONLINE');
  });
});
