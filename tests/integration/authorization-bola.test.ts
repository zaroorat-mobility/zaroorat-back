import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  grantRole,
  makeAssignedVehicle,
  makeDriver,
  makePaidTransaction,
  makePendingIntent,
  makeRide,
  makeRideRequest,
  makeVehicle,
  makeVehicleType,
} from './helpers/fixtures.js';

const CUSTOMER_A = '+919876601001';
const CUSTOMER_B = '+919876601002';
const DRIVER_A = '+919876601003';
const DRIVER_B = '+919876601004';
const ADMIN = '+919876601005';
const FINANCE = '+919876601006';

describe('authorization / BOLA (integration, real HTTP)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  const get = (url: string, user?: LoggedInUser) =>
    app.inject({ method: 'GET', url, ...(user ? { headers: user.authHeader } : {}) });

  const post = (url: string, user?: LoggedInUser, payload?: unknown) =>
    app.inject({
      method: 'POST',
      url,
      ...(user ? { headers: user.authHeader } : {}),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  async function loginWithRole(phone: string, role: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, role);

    return loginAs(app, phone);
  }

  describe('unauthenticated access', () => {
    it('refuses every mounted module with 401, not 404 or 500', async () => {
      const urls = [
        '/api/v1/rides/active',
        '/api/v1/rides/history',
        `/api/v1/rides/${randomUUID()}`,
        '/api/v1/drivers/me',
        '/api/v1/payments/methods',
        '/api/v1/payments/wallet/balance',
      ];

      for (const url of urls) {
        const response = await get(url);
        assert.equal(response.statusCode, 401, `${url} → ${response.payload}`);
        assert.equal(response.json().error.code, 'TOKEN_INVALID', url);
      }
    });

    it('refuses writes too', async () => {
      for (const url of ['/api/v1/rides/requests', '/api/v1/drivers/status/online']) {
        const response = await post(url, undefined, {});
        assert.equal(response.statusCode, 401, `${url} → ${response.payload}`);
      }
    });

    it('rejects a forged token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/active',
        headers: { authorization: 'Bearer not.a.token' },
      });
      assert.equal(response.statusCode, 401);
    });
  });

  describe('ride ownership', () => {
    async function seedRide(): Promise<{
      customer: LoggedInUser;
      driver: LoggedInUser;
      driverId: string;
      rideId: string;
      vehicleId: string;
      vehicleTypeId: string;
    }> {
      const customer = await loginAs(app, CUSTOMER_A);
      const driver = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driver.userId, { verified: true });
      const vehicleTypeId = await makeVehicleType();
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
      const rideId = await makeRide({
        requestId,
        customerId: customer.userId,
        driverId,
        vehicleId,
        vehicleTypeId,
      });
      return { customer, driver, driverId, rideId, vehicleId, vehicleTypeId };
    }

    it('lets both parties read their ride', async () => {
      const { customer, driver, rideId } = await seedRide();

      assert.equal((await get(`/api/v1/rides/${rideId}`, customer)).statusCode, 200);
      assert.equal((await get(`/api/v1/rides/${rideId}`, driver)).statusCode, 200);
    });

    it('refuses a stranger reading someone else’s ride', async () => {
      const { rideId } = await seedRide();
      const stranger = await loginAs(app, CUSTOMER_B);

      const response = await get(`/api/v1/rides/${rideId}`, stranger);
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'FORBIDDEN');
    });

    it('refuses a stranger reading someone else’s receipt', async () => {
      const { rideId } = await seedRide();
      const stranger = await loginAs(app, CUSTOMER_B);

      const response = await get(`/api/v1/rides/${rideId}/receipt`, stranger);
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('scopes ride history to the caller, ignoring any id they supply', async () => {
      const { customer, rideId } = await seedRide();
      const stranger = await loginAs(app, CUSTOMER_B);

      const mine = await get('/api/v1/rides/history', customer);
      assert.equal(mine.statusCode, 200);
      assert.ok(
        (mine.json().data as { id: string }[]).some((r) => r.id === rideId),
        'the owner sees their own ride',
      );

      const theirs = await get(`/api/v1/rides/history?userId=${customer.userId}`, stranger);
      assert.equal(theirs.statusCode, 200);
      assert.deepEqual(theirs.json().data, [], 'a query param cannot borrow another identity');
    });
  });

  describe('ride creation identity', () => {
    it('creates the request as the AUTHENTICATED customer, never body.customerId', async () => {
      const customer = await loginAs(app, CUSTOMER_A);
      const victim = await loginAs(app, CUSTOMER_B);
      const vehicleTypeId = await makeVehicleType();

      const response = await post('/api/v1/rides/requests', customer, {
        vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9352,
        dropLng: 77.6245,

        customerId: victim.userId,
      });

      assert.equal(response.statusCode, 200, response.payload);

      const rows = await db().client.rideRequest.findMany();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.customerId, customer.userId, 'the token decides the customer');
      assert.notEqual(rows[0]!.customerId, victim.userId);
    });

    it('refuses a customer cancelling a ride that is not theirs', async () => {
      const customer = await loginAs(app, CUSTOMER_A);
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: true });
      const vehicleTypeId = await makeVehicleType();
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
      const rideId = await makeRide({
        requestId,
        customerId: customer.userId,
        driverId,
        vehicleId,
        vehicleTypeId,
      });

      const stranger = await loginAs(app, CUSTOMER_B);
      const response = await post(`/api/v1/rides/${rideId}/cancel`, stranger, {
        reasonCode: 'CHANGED_MIND',
      });

      assert.equal(response.statusCode, 403, response.payload);

      const row = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(row.status, 'ACCEPTED', 'the ride is untouched');
    });

    it('lets the real customer cancel their own ride', async () => {
      const customer = await loginAs(app, CUSTOMER_A);
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: true });
      const vehicleTypeId = await makeVehicleType();
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
      const rideId = await makeRide({
        requestId,
        customerId: customer.userId,
        driverId,
        vehicleId,
        vehicleTypeId,
      });

      const response = await post(`/api/v1/rides/${rideId}/cancel`, customer, {
        reasonCode: 'CHANGED_MIND',
      });
      assert.equal(response.statusCode, 200, response.payload);

      const row = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(row.status, 'CANCELLED_BY_CUSTOMER');
    });
  });

  describe('role separation', () => {
    it('refuses a customer on a driver-only endpoint', async () => {
      const customer = await loginAs(app, CUSTOMER_A);

      for (const url of ['/api/v1/rides/accept', '/api/v1/drivers/status/online']) {
        const response = await post(url, customer, {
          requestId: randomUUID(),
          vehicleId: randomUUID(),
        });
        assert.equal(response.statusCode, 403, `${url} → ${response.payload}`);
        assert.equal(response.json().error.code, 'FORBIDDEN', url);
      }
    });

    it('refuses a driver whose verification has not completed', async () => {
      const driver = await loginWithRole(DRIVER_A, 'driver');
      await makeDriver(driver.userId, { verified: false });

      const response = await post('/api/v1/drivers/status/online', driver, {});
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('refuses a suspended driver even though verified', async () => {
      const driver = await loginWithRole(DRIVER_A, 'driver');
      await makeDriver(driver.userId, { verified: true, suspended: true });

      const response = await post('/api/v1/drivers/status/online', driver, {});
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('lets a verified, unsuspended driver with an operable vehicle go online', async () => {
      const driver = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driver.userId, { verified: true });
      // Going online now gates on the vehicle as well as the driver.
      await makeAssignedVehicle(driverId);

      const response = await post('/api/v1/drivers/status/online', driver, {});
      assert.equal(response.statusCode, 200, response.payload);
    });

    it('refuses a fully verified driver who has claimed no vehicle', async () => {
      const driver = await loginWithRole(DRIVER_A, 'driver');
      await makeDriver(driver.userId, { verified: true });

      const response = await post('/api/v1/drivers/status/online', driver, {});
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_MISSING');
    });

    it('refuses a fully verified driver whose vehicle is awaiting review', async () => {
      const driver = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driver.userId, { verified: true });
      await makeAssignedVehicle(driverId, { verified: false });

      const response = await post('/api/v1/drivers/status/online', driver, {});
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_NOT_VERIFIED');
    });
  });

  describe('driver isolation', () => {
    async function twoDrivers() {
      const a = await loginWithRole(DRIVER_A, 'driver');
      const b = await loginWithRole(DRIVER_B, 'driver');
      const aId = await makeDriver(a.userId, { verified: true });
      const bId = await makeDriver(b.userId, { verified: true });
      return { a, b, aId, bId };
    }

    it('refuses reading another driver’s earnings', async () => {
      const { a, bId } = await twoDrivers();

      const response = await get(`/api/v1/drivers/${bId}/wallet`, a);
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('refuses reading another driver’s wallet transactions', async () => {
      const { a, bId } = await twoDrivers();

      const response = await get(`/api/v1/drivers/${bId}/wallet/transactions`, a);
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('serves a driver their OWN earnings even at another id’s path', async () => {
      const { a, aId } = await twoDrivers();

      const response = await get(`/api/v1/drivers/${aId}/wallet`, a);
      assert.equal(response.statusCode, 200, response.payload);
    });

    it('writes a GPS update against the caller, never body.driverId', async () => {
      const { a, b, aId, bId } = await twoDrivers();

      const response = await post('/api/v1/drivers/location', a, {
        latitude: 12.9716,
        longitude: 77.5946,

        driverId: bId,
      });
      assert.equal(response.statusCode, 200, response.payload);

      const mine = await db().client.driverLocation.findUnique({ where: { driverId: aId } });
      const theirs = await db().client.driverLocation.findUnique({ where: { driverId: bId } });
      assert.ok(mine, 'the caller’s own location was written');
      assert.equal(theirs, null, 'the named driver’s location was NOT touched');
      assert.equal(b.userId !== a.userId, true);
    });

    it('refuses reading another driver’s live location', async () => {
      const { a, bId } = await twoDrivers();

      const response = await get(`/api/v1/drivers/${bId}/location`, a);
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('refuses a driver acting on a ride assigned to someone else', async () => {
      const { a, bId } = await twoDrivers();
      const customer = await loginAs(app, CUSTOMER_A);
      const vehicleTypeId = await makeVehicleType();
      const vehicleId = await makeVehicle(vehicleTypeId);
      const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
      const rideId = await makeRide({
        requestId,
        customerId: customer.userId,
        driverId: bId,
        vehicleId,
        vehicleTypeId,
        status: 'DRIVER_ARRIVED',
      });

      const response = await post(`/api/v1/rides/${rideId}/complete`, a, {
        actualDistanceKm: 5,
        actualDurationMin: 12,
      });
      assert.equal(response.statusCode, 403, response.payload);

      const row = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(row.status, 'DRIVER_ARRIVED', 'the ride is untouched');
      assert.equal(await db().client.rideFare.count({ where: { rideId } }), 0, 'no fare written');
    });
  });

  describe('financial authorization', () => {
    it('refuses refunding another user’s transaction', async () => {
      const victim = await loginAs(app, CUSTOMER_A);
      const attacker = await loginAs(app, CUSTOMER_B);
      const { transactionId } = await makePaidTransaction(victim.userId, 500);

      const response = await post('/api/v1/payments/refunds', attacker, {
        transactionId,
        amount: 100,
      });

      assert.notEqual(response.statusCode, 200, response.payload);
      assert.equal(await db().client.refund.count(), 0, 'no refund was created');
    });

    it('caps a refund at the STORED captured amount, not a client-supplied one', async () => {
      const customer = await loginAs(app, CUSTOMER_A);
      const { transactionId } = await makePaidTransaction(customer.userId, 100);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/refunds',
        headers: { ...customer.authHeader, 'idempotency-key': randomUUID() },
        payload: {
          transactionId,
          amount: 5000,

          transactionCapturedAmount: 999999,
        },
      });

      assert.notEqual(response.statusCode, 200, response.payload);
      assert.equal(await db().client.refund.count(), 0, 'no over-refund was created');
    });

    it('requires an Idempotency-Key on a money-moving call', async () => {
      const customer = await loginAs(app, CUSTOMER_A);
      const { transactionId } = await makePaidTransaction(customer.userId, 500);

      const response = await post('/api/v1/payments/refunds', customer, {
        transactionId,
        amount: 50,
      });

      assert.equal(response.statusCode, 400, response.payload);
      assert.equal(response.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    });

    it('refuses confirming another user’s payment intent', async () => {
      const victim = await loginAs(app, CUSTOMER_A);
      const attacker = await loginAs(app, CUSTOMER_B);
      const intentId = await makePendingIntent(victim.userId, 250);

      const response = await post(`/api/v1/payments/intents/${intentId}/confirm`, attacker);
      assert.equal(response.statusCode, 403, response.payload);

      const row = await db().client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      assert.equal(row.status, 'PENDING', 'the intent was not settled');
    });

    it('scopes the wallet to the caller', async () => {
      const a = await loginAs(app, CUSTOMER_A);
      const b = await loginAs(app, CUSTOMER_B);

      const balance = await get('/api/v1/payments/wallet/balance', a);
      assert.equal(balance.statusCode, 200, balance.payload);
      assert.equal(balance.json().data.userId, a.userId);
      assert.notEqual(balance.json().data.userId, b.userId);
    });

    it('refuses a non-finance, non-admin caller executing a payout', async () => {
      const driver = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driver.userId, { verified: true });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/payouts',
        headers: { ...driver.authHeader, 'idempotency-key': randomUUID() },
        payload: { driverId, amount: 100 },
      });

      assert.equal(response.statusCode, 403, response.payload);
    });
  });

  describe('operator endpoints', () => {
    it('refuses a customer approving a driver verification', async () => {
      const customer = await loginAs(app, CUSTOMER_A);
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: false });

      const response = await post(`/api/v1/admin/drivers/${driverId}/verify`, customer, {
        status: 'VERIFIED',
      });
      assert.equal(response.statusCode, 403, response.payload);

      const row = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(row.verificationStatus, 'PENDING', 'the gate did not move');
    });

    it('refuses a DRIVER approving their own verification', async () => {
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: false });

      const response = await post(`/api/v1/admin/drivers/${driverId}/verify`, driverUser, {
        status: 'VERIFIED',
      });
      assert.equal(response.statusCode, 403, response.payload);

      const row = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(row.verificationStatus, 'PENDING');
    });

    it('refuses a customer suspending a driver', async () => {
      const customer = await loginAs(app, CUSTOMER_A);
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: true });

      const response = await post(`/api/v1/admin/drivers/${driverId}/suspend`, customer, {
        isSuspended: true,
      });
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('lets an admin approve a verification', async () => {
      const admin = await loginWithRole(ADMIN, 'admin');
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: false });
      for (const documentType of ['DRIVING_LICENSE', 'RC', 'INSURANCE'] as const) {
        await db().client.driverDocument.create({
          data: {
            driverId,
            documentType,
            verificationStatus: 'VERIFIED',
            fileUrl: `https://example.invalid/${documentType.toLowerCase()}.jpg`,
          },
        });
      }

      const response = await post(`/api/v1/admin/drivers/${driverId}/verify`, admin, {
        status: 'VERIFIED',
      });
      assert.equal(response.statusCode, 200, response.payload);

      const row = await db().client.driver.findUniqueOrThrow({ where: { id: driverId } });
      assert.equal(row.verificationStatus, 'VERIFIED');
      assert.equal(row.approvedBy, admin.userId, 'the reviewer is recorded from the token');
    });
  });

  describe('the finance role', () => {
    it('exists in the seed', async () => {
      const role = await db().client.role.findUnique({ where: { slug: 'finance' } });
      assert.ok(role, '`finance` must be a seeded role');
    });

    it('lets finance reach the payout endpoint', async () => {
      const finance = await loginWithRole(FINANCE, 'finance');
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: true });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/payouts',
        headers: { ...finance.authHeader, 'idempotency-key': randomUUID() },
        payload: { driverId, amount: 100 },
      });

      assert.notEqual(response.statusCode, 403, response.payload);
    });

    it('does NOT let finance approve driver verification', async () => {
      const finance = await loginWithRole(FINANCE, 'finance');
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: false });

      const response = await post(`/api/v1/admin/drivers/${driverId}/verify`, finance, {
        status: 'VERIFIED',
      });
      assert.equal(response.statusCode, 403, response.payload);
    });

    it('does NOT let finance suspend a driver', async () => {
      const finance = await loginWithRole(FINANCE, 'finance');
      const driverUser = await loginWithRole(DRIVER_A, 'driver');
      const driverId = await makeDriver(driverUser.userId, { verified: true });

      const response = await post(`/api/v1/admin/drivers/${driverId}/suspend`, finance, {
        isSuspended: true,
      });
      assert.equal(response.statusCode, 403, response.payload);
    });
  });

  describe('file isolation', () => {
    it('refuses reading another user’s file', async () => {
      const owner = await loginAs(app, CUSTOMER_A);
      const stranger = await loginAs(app, CUSTOMER_B);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { ...owner.authHeader, 'idempotency-key': randomUUID() },
        payload: {
          purpose: 'PROFILE_IMAGE',
          fileName: 'me.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 1024,
        },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const body = created.json();
      const fileId = body.fileId ?? body.id ?? body.data?.id;
      assert.ok(fileId, `could not read the file id from ${created.payload}`);

      const response = await get(`/api/v1/files/${fileId}`, stranger);
      assert.ok(
        response.statusCode === 403 || response.statusCode === 404,
        `expected a refusal, got ${response.statusCode}: ${response.payload}`,
      );
    });
  });
});
