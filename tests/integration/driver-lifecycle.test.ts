import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { vehicleConfig } from '../../src/config/vehicle/vehicle.config.js';
import { container } from '../../src/core/di.js';
import { png as image } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';
import type { OutboxRelay } from '../../src/core/events/OutboxRelay.js';
import type { AuthDriverVerifiedConsumer } from '../../src/modules/auth/consumers/driver-verified.consumer.js';
import type { GeoService } from '../../src/modules/geo/services/geo.service.js';
import type { NearbyDriversResult } from '../../src/modules/geo/types/geo.types.js';

function png(): Buffer {
  return image({ width: 400, height: 300 });
}

const CENTRE = { latitude: 12.9716, longitude: 77.5946 };
const REQUIRED_TYPES = ['DRIVING_LICENSE', 'RC', 'INSURANCE'];
const VEHICLE_REQUIRED_TYPES = vehicleConfig.requiredDocumentTypes;

function driverIdsOf(result: NearbyDriversResult): string[] {
  return result.outcome === 'no-live-candidates' ? [] : result.drivers.map((d) => d.driverId);
}

describe('driver verification lifecycle — full production path (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
    container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer').register();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
    provider.reset();
  });

  async function uploadFile(
    auth: { authorization: string },
    purpose: 'DRIVER_DOCUMENT' | 'VEHICLE_DOCUMENT' = 'DRIVER_DOCUMENT',
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: {
        purpose,
        fileName: 'doc.png',
        contentType: 'image/png',
        sizeBytes: 2048,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, png(), 'image/png');
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    assert.equal(completed.statusCode, 200, completed.payload);
    return fileId;
  }

  it('runs phone → OTP → onboarding → documents → review → approval → role → online → geo end to end', async () => {
    // 1-2. Phone → OTP → authenticated user.
    const driver = await loginAs(app, '+919876690001');

    // 3. Driver onboarding.
    const me1 = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: driver.authHeader,
    });
    assert.equal(me1.statusCode, 201, me1.payload);
    const driverId = me1.json().data.id as string;

    // 19. Duplicate onboarding stays safe — still one Driver row.
    const me2 = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/me/onboard',
      headers: driver.authHeader,
    });
    assert.equal(me2.json().data.id, driverId);
    assert.equal(await db().client.driver.count({ where: { userId: driver.userId } }), 1);

    // 4. Profile completion.
    const profile = await app.inject({
      method: 'PATCH',
      url: `/api/v1/drivers/${driverId}/profile`,
      headers: driver.authHeader,
      payload: { fullLegalName: 'Asha Rao', city: 'Bengaluru' },
    });
    assert.equal(profile.statusCode, 200, profile.payload);

    // 5-6. File upload + secure document submission for every required type.
    const documentIds: string[] = [];
    for (const documentType of REQUIRED_TYPES) {
      const fileId = await uploadFile(driver.authHeader);
      const submitted = await app.inject({
        method: 'POST',
        url: `/api/v1/drivers/${driverId}/documents`,
        headers: driver.authHeader,
        payload: { documentType, fileId },
      });
      assert.equal(submitted.statusCode, 201, submitted.payload);
      documentIds.push(submitted.json().data.id as string);
    }

    // 20. Duplicate document-type submission stays a single row (DB constraint).
    const secondLicenceFile = await uploadFile(driver.authHeader);
    await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/documents`,
      headers: driver.authHeader,
      payload: { documentType: 'DRIVING_LICENSE', fileId: secondLicenceFile },
    });
    assert.equal(
      await db().client.driverDocument.count({
        where: { driverId, documentType: 'DRIVING_LICENSE' },
      }),
      1,
    );
    const licenceRow = await db().client.driverDocument.findFirstOrThrow({
      where: { driverId, documentType: 'DRIVING_LICENSE' },
    });
    documentIds[0] = licenceRow.id;

    // Driver moved out of PENDING once the first document was submitted.
    const afterSubmission = await db().client.driver.findUniqueOrThrow({
      where: { id: driverId },
    });
    assert.equal(afterSubmission.verificationStatus, 'DOCUMENT_REVIEW');

    // Admin actor.
    const adminSeed = await loginAs(app, '+919876690002');
    await grantRole(adminSeed.userId, 'admin');
    const admin = await loginAs(app, '+919876690002');

    // 7. Negative: admin approval attempted before any document is reviewed → 422.
    const tooEarly = await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(tooEarly.statusCode, 422, tooEarly.payload);

    // 8. Admin reviews every submitted document VERIFIED.
    for (const documentId of documentIds) {
      const reviewed = await app.inject({
        method: 'POST',
        url: `/api/v1/drivers/${driverId}/documents/${documentId}/review`,
        headers: admin.authHeader,
        payload: { status: 'VERIFIED' },
      });
      assert.equal(reviewed.statusCode, 200, reviewed.payload);
    }

    // 9. Admin approves the driver.
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/drivers/${driverId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(approved.statusCode, 200, approved.payload);

    // 10-11. driver.verified is on the outbox and relays to the role grant.
    const events = await db().client.outboxEvent.findMany({
      where: { eventType: 'driver.verified' },
    });
    assert.equal(events.length, 1);
    await container.resolve<OutboxRelay>('outboxRelay').processBatch(100);

    const driverRole = await db().client.role.findUniqueOrThrow({ where: { slug: 'driver' } });
    assert.equal(
      await db().client.userRoleAssignment.count({
        where: { userId: driver.userId, roleId: driverRole.id, revokedAt: null },
      }),
      1,
    );

    // 12. Token refresh carries the new role.
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token/refresh',
      headers: { 'idempotency-key': randomUUID() },
      payload: { refreshToken: driver.refreshToken },
    });
    assert.equal(refreshed.statusCode, 200, refreshed.payload);
    const freshAuthHeader = { authorization: `Bearer ${refreshed.json().accessToken}` };
    const meAfterRefresh = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: freshAuthHeader,
    });
    assert.ok([...meAfterRefresh.json().roles].includes('driver'));

    // 12a. Going online is refused before a vehicle exists — a distinct code
    // from the driver-document gate, so the app can tell the two apart.
    const noVehicle = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: freshAuthHeader,
      payload: {},
    });
    assert.equal(noVehicle.statusCode, 409, noVehicle.payload);
    assert.equal(noVehicle.json().error.code, 'VEHICLE_MISSING');

    // 12b. Vehicle catalog → claim → documents → review → approval, entirely
    // over the public API. No test here touches the vehicle tables directly:
    // the point is that a driver can finish onboarding without one.
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/v1/vehicle-types',
      headers: freshAuthHeader,
    });
    assert.equal(catalog.statusCode, 200, catalog.payload);
    const vehicleTypeId = catalog.json().data[0]?.id as string;
    assert.ok(vehicleTypeId, 'the seeded catalog must expose at least one active type');

    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/vehicles/me/claim',
      headers: freshAuthHeader,
      payload: { registrationNumber: 'KA01AB1234', vehicleTypeId },
    });
    assert.equal(claimed.statusCode, 200, claimed.payload);
    const vehicleId = claimed.json().data.id as string;
    assert.equal(claimed.json().data.verificationStatus, 'PENDING');

    // A claimed but unreviewed vehicle still blocks going online.
    const unverifiedVehicle = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: freshAuthHeader,
      payload: {},
    });
    assert.equal(unverifiedVehicle.statusCode, 403, unverifiedVehicle.payload);
    assert.equal(unverifiedVehicle.json().error.code, 'VEHICLE_NOT_VERIFIED');

    const vehicleDocumentIds: string[] = [];
    for (const documentType of VEHICLE_REQUIRED_TYPES) {
      const fileId = await uploadFile(freshAuthHeader, 'VEHICLE_DOCUMENT');
      const submitted = await app.inject({
        method: 'POST',
        url: `/api/v1/vehicles/${vehicleId}/documents`,
        headers: freshAuthHeader,
        payload: { documentType, fileId },
      });
      assert.equal(submitted.statusCode, 201, submitted.payload);
      vehicleDocumentIds.push(submitted.json().data.id as string);
    }

    // Approval before the documents are reviewed is refused, exactly as it is
    // for a driver.
    const vehicleTooEarly = await app.inject({
      method: 'POST',
      url: `/api/v1/vehicles/${vehicleId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(vehicleTooEarly.statusCode, 403, vehicleTooEarly.payload);
    assert.equal(vehicleTooEarly.json().error.code, 'VEHICLE_DOCUMENTS_INCOMPLETE');

    for (const documentId of vehicleDocumentIds) {
      const reviewed = await app.inject({
        method: 'POST',
        url: `/api/v1/vehicles/${vehicleId}/documents/${documentId}/review`,
        headers: admin.authHeader,
        payload: { status: 'VERIFIED' },
      });
      assert.equal(reviewed.statusCode, 200, reviewed.payload);
    }

    const vehicleApproved = await app.inject({
      method: 'POST',
      url: `/api/v1/vehicles/${vehicleId}/verify`,
      headers: admin.authHeader,
      payload: { status: 'VERIFIED' },
    });
    assert.equal(vehicleApproved.statusCode, 200, vehicleApproved.payload);
    assert.equal(vehicleApproved.json().data.verificationStatus, 'VERIFIED');

    // 13. Go online.
    const online = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: freshAuthHeader,
      payload: {},
    });
    assert.equal(online.statusCode, 200, online.payload);
    const onlineStatus = await db().client.driverOnlineStatus.findUniqueOrThrow({
      where: { driverId },
    });
    assert.equal(onlineStatus.status, 'ONLINE');
    assert.ok(onlineStatus.currentShiftId);
    assert.ok(
      await db().client.driverShiftLog.findFirst({
        where: { driverId, shiftEnd: null },
      }),
    );

    // 14. Location publishes to the live geo index for a verified, online driver.
    const posted = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      headers: freshAuthHeader,
      payload: CENTRE,
    });
    assert.equal(posted.statusCode, 200, posted.payload);
    const geo = container.resolve<GeoService>('geoService');
    const nearby = await geo.findNearbyDrivers({ origin: CENTRE, radiusMeters: 1000 });
    assert.ok(driverIdsOf(nearby).includes(driverId));

    // 21. Re-delivering the same driver.verified event a second time is a no-op.
    const consumer = container.resolve<AuthDriverVerifiedConsumer>('authDriverVerifiedConsumer');
    await (consumer as unknown as { handle: (e: unknown) => Promise<void> }).handle({
      eventId: randomUUID(),
      type: 'driver.verified',
      data: { driverId, approvedBy: admin.userId, userId: driver.userId },
    });
    assert.equal(
      await db().client.userRoleAssignment.count({
        where: { userId: driver.userId, roleId: driverRole.id, revokedAt: null },
      }),
      1,
    );
  });
});
