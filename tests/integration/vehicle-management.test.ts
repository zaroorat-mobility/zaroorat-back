import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  grantRole,
  makeAssignedVehicle,
  makeDispatchOffer,
  markDriverOnline,
  makeDriver,
  makeRideRequest,
  makeVehicleType,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import { vehicleConfig } from '../../src/config/vehicle/vehicle.config.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';

const DRIVER_A = '+919876720001';
const DRIVER_B = '+919876720002';
const ADMIN = '+919876720003';
const CUSTOMER = '+919876720004';

// Asserted non-empty so `REQUIRED[0]` is a string rather than `string | undefined`
// under `noUncheckedIndexedAccess` — an empty required list would make every
// document case in this file vacuous anyway.
const REQUIRED = vehicleConfig.requiredDocumentTypes as [string, ...string[]];

describe('driver vehicle management, documents and verification (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
    provider.reset();
  });

  // Awaited rather than returned raw: `inject` is overloaded, and handing it a
  // widened `payload` type makes TypeScript pick the chainable overload, whose
  // result has no `statusCode`.
  async function get(url: string, user: LoggedInUser) {
    return await app.inject({ method: 'GET', url, headers: user.authHeader });
  }
  async function post(url: string, user: LoggedInUser, payload: Record<string, unknown> = {}) {
    return await app.inject({ method: 'POST', url, headers: user.authHeader, payload });
  }
  async function patch(url: string, user: LoggedInUser, payload: Record<string, unknown>) {
    return await app.inject({ method: 'PATCH', url, headers: user.authHeader, payload });
  }

  async function loginWithRole(phone: string, slug: string): Promise<LoggedInUser> {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, slug);
    return loginAs(app, phone);
  }

  /// Goes through the real Files handshake — presign, put bytes, complete —
  /// because the whole point of the document endpoint is that it accepts only a
  /// file the Files module has already validated.
  async function uploadFile(
    user: LoggedInUser,
    purpose: 'VEHICLE_DOCUMENT' | 'PROFILE_IMAGE' = 'VEHICLE_DOCUMENT',
    options: { complete?: boolean } = {},
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
      payload: { purpose, fileName: 'doc.png', contentType: 'image/png', sizeBytes: 2048 },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, image({ width: 400, height: 300 }), 'image/png');
    if (options.complete === false) return fileId;
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: user.authHeader,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return fileId;
  }

  async function driverWithVehicle(
    phone: string,
  ): Promise<{ user: LoggedInUser; driverId: string; vehicleId: string; vehicleTypeId: string }> {
    const user = await loginWithRole(phone, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true });
    const catalog = (await get('/api/v1/vehicle-types', user)).json().data as { id: string }[];
    const vehicleTypeId = catalog[0]!.id;
    const claimed = await post('/api/v1/vehicles/me/claim', user, {
      registrationNumber: `KA${phone.slice(-6)}`,
      vehicleTypeId,
    });
    assert.equal(claimed.statusCode, 200, claimed.payload);
    return { user, driverId, vehicleId: claimed.json().data.id as string, vehicleTypeId };
  }

  describe('GET /vehicles/me', () => {
    it('returns null before anything is claimed rather than 404', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      await makeDriver(user.userId, { verified: true });

      const response = await get('/api/v1/vehicles/me', user);
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data, null);
    });

    it('returns the claimed vehicle with its type and documents', async () => {
      const { user, vehicleId, vehicleTypeId } = await driverWithVehicle(DRIVER_A);

      const response = await get('/api/v1/vehicles/me', user);
      assert.equal(response.statusCode, 200, response.payload);
      const vehicle = response.json().data;
      assert.equal(vehicle.id, vehicleId);
      assert.equal(vehicle.vehicleTypeId, vehicleTypeId);
      assert.equal(vehicle.vehicleType.id, vehicleTypeId);
      assert.deepEqual(vehicle.documents, []);
    });
  });

  describe('ownership', () => {
    it('refuses a driver updating another driver’s vehicle', async () => {
      const a = await driverWithVehicle(DRIVER_A);
      const b = await driverWithVehicle(DRIVER_B);

      const response = await patch(`/api/v1/vehicles/${a.vehicleId}`, b.user, { color: 'Red' });
      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_NOT_FOUND', 'must not confirm it exists');

      const untouched = await db().client.vehicle.findUniqueOrThrow({ where: { id: a.vehicleId } });
      assert.notEqual(untouched.color, 'Red');
    });

    it('refuses a driver attaching a document to another driver’s vehicle', async () => {
      const a = await driverWithVehicle(DRIVER_A);
      const b = await driverWithVehicle(DRIVER_B);
      const fileId = await uploadFile(b.user);

      const response = await post(`/api/v1/vehicles/${a.vehicleId}/documents`, b.user, {
        documentType: REQUIRED[0],
        fileId,
      });
      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(await db().client.vehicleDocument.count(), 0);
    });

    it('refuses a driver reading another driver’s vehicle documents', async () => {
      const a = await driverWithVehicle(DRIVER_A);
      const b = await driverWithVehicle(DRIVER_B);

      const response = await get(`/api/v1/vehicles/${a.vehicleId}/documents`, b.user);
      assert.equal(response.statusCode, 404, response.payload);
    });

    it('lets an admin read any vehicle’s documents', async () => {
      const a = await driverWithVehicle(DRIVER_A);
      const admin = await loginWithRole(ADMIN, 'admin');

      const response = await get(`/api/v1/vehicles/${a.vehicleId}/documents`, admin);
      assert.equal(response.statusCode, 200, response.payload);
    });
  });

  describe('PATCH /vehicles/:id', () => {
    it('updates the editable descriptive fields', async () => {
      const { user, vehicleId } = await driverWithVehicle(DRIVER_A);

      const response = await patch(`/api/v1/vehicles/${vehicleId}`, user, {
        color: 'Midnight Blue',
        make: 'Maruti',
      });
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.color, 'Midnight Blue');
      assert.equal(response.json().data.make, 'Maruti');
    });

    it('ignores an attempt to change the registration number or category', async () => {
      const { user, vehicleId, vehicleTypeId } = await driverWithVehicle(DRIVER_A);
      const before = await db().client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });

      // The route schema declares `additionalProperties: false`, and Fastify's
      // ajv strips unknown keys rather than rejecting the request — so these are
      // dropped before any handler sees them. Silently ignored, never applied:
      // that is the mass-assignment guarantee this test is protecting.
      const response = await patch(`/api/v1/vehicles/${vehicleId}`, user, {
        color: 'Grey',
        registrationNumber: 'KA99ZZ0000',
        vehicleTypeId: randomUUID(),
      });
      assert.equal(response.statusCode, 200, response.payload);

      const row = await db().client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      assert.equal(row.color, 'Grey', 'the permitted field is applied');
      assert.equal(row.registrationNumber, before.registrationNumber);
      assert.equal(row.vehicleTypeId, vehicleTypeId);
    });

    it('returns a VERIFIED vehicle to PENDING when its details change', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      const { vehicleId } = await makeAssignedVehicle(driverId);

      const response = await patch(`/api/v1/vehicles/${vehicleId}`, user, { color: 'Green' });
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(
        response.json().data.verificationStatus,
        'PENDING',
        'an approval describes the details that were reviewed',
      );
    });
  });

  describe('POST /vehicles/me/release', () => {
    it('ends the assignment and frees the vehicle', async () => {
      const { user, driverId, vehicleId } = await driverWithVehicle(DRIVER_A);

      const response = await post('/api/v1/vehicles/me/release', user);
      assert.equal(response.statusCode, 204, response.payload);

      const vehicle = await db().client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      assert.equal(vehicle.currentDriverId, null);
      assert.equal(vehicle.isActive, true, 'the vehicle row outlives the assignment');

      const driver = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(driver.currentVehicleId, null);

      assert.equal(
        await db().client.vehicleAssignment.count({ where: { driverId, status: 'ACTIVE' } }),
        0,
      );
      assert.equal((await get('/api/v1/vehicles/me', user)).json().data, null);
    });

    it('refuses to release with no vehicle assigned', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      await makeDriver(user.userId, { verified: true });

      const response = await post('/api/v1/vehicles/me/release', user);
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_MISSING');
    });

    it('refuses to release while the driver is on a trip', async () => {
      const { user, driverId } = await driverWithVehicle(DRIVER_A);
      await db().client.driverOnlineStatus.create({
        data: { driverId, status: 'ON_TRIP' },
      });

      const response = await post('/api/v1/vehicles/me/release', user);
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_IN_USE');
    });

    it('lets another driver claim a released vehicle', async () => {
      const a = await driverWithVehicle(DRIVER_A);
      const registration = (
        await db().client.vehicle.findUniqueOrThrow({ where: { id: a.vehicleId } })
      ).registrationNumber;

      await post('/api/v1/vehicles/me/release', a.user);

      const b = await loginWithRole(DRIVER_B, 'driver');
      await makeDriver(b.userId, { verified: true });
      const claimed = await post('/api/v1/vehicles/me/claim', b, {
        registrationNumber: registration,
        vehicleTypeId: a.vehicleTypeId,
      });
      assert.equal(claimed.statusCode, 200, claimed.payload);
      assert.equal(claimed.json().data.id, a.vehicleId, 'the same vehicle row is reused');
    });

    it('refuses to claim a vehicle another driver still holds', async () => {
      const a = await driverWithVehicle(DRIVER_A);
      const registration = (
        await db().client.vehicle.findUniqueOrThrow({ where: { id: a.vehicleId } })
      ).registrationNumber;

      const b = await loginWithRole(DRIVER_B, 'driver');
      await makeDriver(b.userId, { verified: true });
      const claimed = await post('/api/v1/vehicles/me/claim', b, {
        registrationNumber: registration,
        vehicleTypeId: a.vehicleTypeId,
      });
      assert.equal(claimed.statusCode, 409, claimed.payload);
      assert.equal(claimed.json().error.code, 'VEHICLE_ALREADY_ASSIGNED');
    });
  });

  describe('vehicle documents reuse the Files module', () => {
    it('links a READY file owned by the caller', async () => {
      const { user, vehicleId } = await driverWithVehicle(DRIVER_A);
      const fileId = await uploadFile(user);

      const response = await post(`/api/v1/vehicles/${vehicleId}/documents`, user, {
        documentType: REQUIRED[0],
        fileId,
      });
      assert.equal(response.statusCode, 201, response.payload);
      assert.equal(response.json().data.fileId, fileId);
      assert.equal(response.json().data.verificationStatus, 'PENDING');
    });

    it('refuses a file the caller does not own', async () => {
      const a = await driverWithVehicle(DRIVER_A);
      const b = await driverWithVehicle(DRIVER_B);
      const otherFile = await uploadFile(b.user);

      const response = await post(`/api/v1/vehicles/${a.vehicleId}/documents`, a.user, {
        documentType: REQUIRED[0],
        fileId: otherFile,
      });
      assert.notEqual(response.statusCode, 201, response.payload);
      assert.equal(await db().client.vehicleDocument.count(), 0);
    });

    it('refuses a file uploaded under the wrong purpose', async () => {
      const { user, vehicleId } = await driverWithVehicle(DRIVER_A);
      const avatar = await uploadFile(user, 'PROFILE_IMAGE');

      const response = await post(`/api/v1/vehicles/${vehicleId}/documents`, user, {
        documentType: REQUIRED[0],
        fileId: avatar,
      });
      assert.notEqual(response.statusCode, 201, response.payload);
      assert.equal(await db().client.vehicleDocument.count(), 0);
    });

    it('refuses a file that never completed its upload', async () => {
      const { user, vehicleId } = await driverWithVehicle(DRIVER_A);
      const pending = await uploadFile(user, 'VEHICLE_DOCUMENT', { complete: false });

      const response = await post(`/api/v1/vehicles/${vehicleId}/documents`, user, {
        documentType: REQUIRED[0],
        fileId: pending,
      });
      assert.notEqual(response.statusCode, 201, response.payload);
      assert.equal(await db().client.vehicleDocument.count(), 0);
    });

    it('refuses an unknown document type', async () => {
      const { user, vehicleId } = await driverWithVehicle(DRIVER_A);
      const fileId = await uploadFile(user);

      const response = await post(`/api/v1/vehicles/${vehicleId}/documents`, user, {
        documentType: 'NOT_A_REAL_TYPE',
        fileId,
      });
      assert.equal(response.statusCode, 400, response.payload);
    });

    it('replaces rather than duplicates on re-submission, and supersedes the old file', async () => {
      const { user, vehicleId } = await driverWithVehicle(DRIVER_A);
      const first = await uploadFile(user);
      await post(`/api/v1/vehicles/${vehicleId}/documents`, user, {
        documentType: REQUIRED[0],
        fileId: first,
      });

      const second = await uploadFile(user);
      const resubmitted = await post(`/api/v1/vehicles/${vehicleId}/documents`, user, {
        documentType: REQUIRED[0],
        fileId: second,
      });
      assert.equal(resubmitted.statusCode, 201, resubmitted.payload);

      assert.equal(
        await db().client.vehicleDocument.count({
          where: { vehicleId, documentType: REQUIRED[0] },
        }),
        1,
        'one row per (vehicle, document type)',
      );
      assert.equal(resubmitted.json().data.fileId, second);

      const superseded = await db().client.file.findUniqueOrThrow({ where: { id: first } });
      assert.equal(superseded.supersededById, second, 'the old file goes to retention');
    });

    it('returns a VERIFIED vehicle to PENDING when a required document is re-submitted', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      const { vehicleId } = await makeAssignedVehicle(driverId);
      const fileId = await uploadFile(user);

      const response = await post(`/api/v1/vehicles/${vehicleId}/documents`, user, {
        documentType: REQUIRED[0],
        fileId,
      });
      assert.equal(response.statusCode, 201, response.payload);

      const vehicle = await db().client.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      assert.equal(vehicle.verificationStatus, 'PENDING');
    });
  });

  describe('admin verification', () => {
    async function driverWithSubmittedDocuments() {
      const world = await driverWithVehicle(DRIVER_A);
      const documentIds: string[] = [];
      for (const documentType of REQUIRED) {
        const fileId = await uploadFile(world.user);
        const submitted = await post(`/api/v1/vehicles/${world.vehicleId}/documents`, world.user, {
          documentType,
          fileId,
        });
        assert.equal(submitted.statusCode, 201, submitted.payload);
        documentIds.push(submitted.json().data.id as string);
      }
      return { ...world, documentIds };
    }

    it('refuses a non-admin', async () => {
      const { user, vehicleId } = await driverWithVehicle(DRIVER_A);

      const response = await post(`/api/v1/admin/vehicles/${vehicleId}/verify`, user, {
        status: 'VERIFIED',
      });
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('refuses approval before the documents are reviewed', async () => {
      const world = await driverWithSubmittedDocuments();
      const admin = await loginWithRole(ADMIN, 'admin');

      const response = await post(`/api/v1/admin/vehicles/${world.vehicleId}/verify`, admin, {
        status: 'VERIFIED',
      });
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_DOCUMENTS_INCOMPLETE');
    });

    it('approves once every document is VERIFIED, and records the reviewer', async () => {
      const world = await driverWithSubmittedDocuments();
      const admin = await loginWithRole(ADMIN, 'admin');

      for (const documentId of world.documentIds) {
        const reviewed = await post(
          `/api/v1/admin/vehicles/${world.vehicleId}/documents/${documentId}/review`,
          admin,
          { status: 'VERIFIED' },
        );
        assert.equal(reviewed.statusCode, 200, reviewed.payload);
      }

      const approved = await post(`/api/v1/admin/vehicles/${world.vehicleId}/verify`, admin, {
        status: 'VERIFIED',
      });
      assert.equal(approved.statusCode, 200, approved.payload);
      assert.equal(approved.json().data.verificationStatus, 'VERIFIED');

      const row = await db().client.vehicle.findUniqueOrThrow({ where: { id: world.vehicleId } });
      assert.equal(row.verifiedBy, admin.userId);
      assert.ok(row.verifiedAt);
    });

    it('records the rejection reason', async () => {
      const world = await driverWithSubmittedDocuments();
      const admin = await loginWithRole(ADMIN, 'admin');

      const rejected = await post(`/api/v1/admin/vehicles/${world.vehicleId}/verify`, admin, {
        status: 'REJECTED',
        rejectionReason: 'Number plate illegible',
      });
      assert.equal(rejected.statusCode, 200, rejected.payload);

      const row = await db().client.vehicle.findUniqueOrThrow({ where: { id: world.vehicleId } });
      assert.equal(row.verificationStatus, 'REJECTED');
      assert.equal(row.rejectionReason, 'Number plate illegible');
    });

    it('refuses to let a reviewer approve their own vehicle', async () => {
      const seed = await loginAs(app, DRIVER_A);
      await grantRole(seed.userId, 'driver');
      await grantRole(seed.userId, 'admin');
      const user = await loginAs(app, DRIVER_A);
      const driverId = await makeDriver(user.userId, { verified: true });
      const { vehicleId } = await makeAssignedVehicle(driverId);

      const response = await post(`/api/v1/admin/vehicles/${vehicleId}/verify`, user, {
        status: 'VERIFIED',
      });
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'SELF_REVIEW_FORBIDDEN');
    });

    it('exposes a vehicle with its documents for review', async () => {
      const world = await driverWithSubmittedDocuments();
      const admin = await loginWithRole(ADMIN, 'admin');

      const response = await get(`/api/v1/admin/vehicles/${world.vehicleId}/review`, admin);
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.vehicle.id, world.vehicleId);
      assert.equal(response.json().data.documents.length, REQUIRED.length);
    });
  });

  describe('ride acceptance checks the vehicle', () => {
    async function pendingRequest(vehicleTypeId: string): Promise<string> {
      const customer = await loginAs(app, CUSTOMER);
      return makeRideRequest(customer.userId, vehicleTypeId);
    }

    it('refuses acceptance with a vehicle of the wrong category', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      const { vehicleId } = await makeAssignedVehicle(driverId);
      const otherTypeId = await makeVehicleType({ code: 'OTHER' });
      const requestId = await pendingRequest(otherTypeId);
      await markDriverOnline(driverId);
      await makeDispatchOffer(requestId, driverId);

      const response = await post('/api/v1/rides/accept', user, { requestId, vehicleId });
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_MISMATCH');
      assert.equal(await db().client.ride.count(), 0);
    });

    it('refuses acceptance with a vehicle that is not assigned to the driver', async () => {
      const a = await loginWithRole(DRIVER_A, 'driver');
      const aId = await makeDriver(a.userId, { verified: true });
      const aVehicle = await makeAssignedVehicle(aId);

      const b = await loginWithRole(DRIVER_B, 'driver');
      const bId = await makeDriver(b.userId, { verified: true });
      await makeAssignedVehicle(bId, { vehicleTypeId: aVehicle.vehicleTypeId });

      const requestId = await pendingRequest(aVehicle.vehicleTypeId);
      await markDriverOnline(bId);
      await makeDispatchOffer(requestId, bId);

      const response = await post('/api/v1/rides/accept', b, {
        requestId,
        vehicleId: aVehicle.vehicleId,
      });
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_MISMATCH');
      assert.equal(await db().client.ride.count(), 0);
    });

    it('refuses acceptance with an unverified vehicle', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId, { verified: false });
      const requestId = await pendingRequest(vehicleTypeId);
      await markDriverOnline(driverId);
      await makeDispatchOffer(requestId, driverId);

      const response = await post('/api/v1/rides/accept', user, { requestId, vehicleId });
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_NOT_VERIFIED');
      assert.equal(await db().client.ride.count(), 0);
    });

    it('refuses acceptance with a deactivated vehicle', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
      await db().client.vehicle.update({ where: { id: vehicleId }, data: { isActive: false } });
      const requestId = await pendingRequest(vehicleTypeId);
      await markDriverOnline(driverId);
      await makeDispatchOffer(requestId, driverId);

      const response = await post('/api/v1/rides/accept', user, { requestId, vehicleId });
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_INACTIVE');
      assert.equal(await db().client.ride.count(), 0);
    });

    it('accepts with an operable, correctly categorised vehicle', async () => {
      const user = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(user.userId, { verified: true });
      const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
      const requestId = await pendingRequest(vehicleTypeId);
      await markDriverOnline(driverId);
      await makeDispatchOffer(requestId, driverId);

      const response = await post('/api/v1/rides/accept', user, { requestId, vehicleId });
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(await db().client.ride.count(), 1);
    });
  });
});
