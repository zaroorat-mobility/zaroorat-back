import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeDriver, makeVehicle, vehicleTypeIdByCode } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { AdminDashboardService } from '../../src/modules/admin/dashboard/dashboard.service.js';

const ADMIN_PHONE = '+919876545402';
const ADMIN_EMAIL = 'dashboard-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('Admin Dashboard - In-Flight Riders (Integration & Performance)', () => {
  let app: FastifyInstance;
  let dashboardService: AdminDashboardService;

  before(async () => {
    app = await bootApp();
    dashboardService = new AdminDashboardService(db());
  });

  after(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    await resetState();
  });

  async function loginAdmin() {
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, 'admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return {
      authorization: `Bearer ${loggedIn.json().accessToken}`,
      userId: seed.userId,
    };
  }

  async function createCustomer(
    phone = `+919876${Math.floor(100000 + Math.random() * 900000)}`,
  ): Promise<string> {
    const user = await loginAs(app, phone);
    return user.userId;
  }

  async function createDriverWithVehicle(): Promise<{
    driverId: string;
    vehicleId: string;
    vehicleTypeId: string;
  }> {
    const driverPhone = `+919875${Math.floor(100000 + Math.random() * 900000)}`;
    const driverUser = await loginAs(app, driverPhone);
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const vehicleId = await makeVehicle(vehicleTypeId);
    await db().client.vehicleAssignment.create({
      data: { driverId, vehicleId, status: 'ACTIVE' },
    });
    await db().client.driverOnlineStatus.create({
      data: { driverId, status: 'ONLINE', lastOnlineAt: new Date() },
    });
    return { driverId, vehicleId, vehicleTypeId };
  }

  async function insertRequest(
    customerId: string,
    vehicleTypeId: string,
    status: 'CREATED' | 'SEARCHING' | 'MATCHED' | 'EXPIRED' | 'ABANDONED',
    expiresAt: Date | null = new Date(Date.now() + 5 * 60 * 1000),
  ): Promise<string> {
    const id = randomUUID();
    await db().client.$executeRawUnsafe(
      `INSERT INTO ride_requests
         (id, customer_id, vehicle_type_id, pickup_lat, pickup_lng, pickup_location,
          drop_lat, drop_lng, status, surge_multiplier, payment_method, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 12.9716, 77.5946,
               ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
               12.9352, 77.6245, $4::"RideRequestStatus", 1.0, 'CASH', $5, now())`,
      id,
      customerId,
      vehicleTypeId,
      status,
      expiresAt,
    );
    return id;
  }

  async function insertRide(
    requestId: string,
    customerId: string,
    driverId: string,
    vehicleId: string,
    vehicleTypeId: string,
    status:
      | 'ACCEPTED'
      | 'DRIVER_ARRIVING'
      | 'DRIVER_ARRIVED'
      | 'IN_PROGRESS'
      | 'COMPLETED'
      | 'CANCELLED_BY_CUSTOMER'
      | 'CANCELLED_BY_DRIVER',
  ): Promise<string> {
    const id = randomUUID();
    await db().client.$executeRawUnsafe(
      `INSERT INTO rides
         (id, ride_code, request_id, customer_id, driver_id, vehicle_id, vehicle_type_id,
          status, payment_method, payment_status, pickup_location, accepted_at,
          wait_time_min, is_scheduled, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
               $8::"RideStatus", 'CASH', 'PENDING',
               ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography, now(),
               0, false, now(), now())`,
      id,
      `RIDE_${randomUUID().slice(0, 8).toUpperCase()}`,
      requestId,
      customerId,
      driverId,
      vehicleId,
      vehicleTypeId,
      status,
    );
    return id;
  }

  it('1. No active riders -> 0', async () => {
    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 0);
  });

  it('2. One searching rider -> 1', async () => {
    const customerId = await createCustomer();
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    await insertRequest(customerId, vehicleTypeId, 'SEARCHING');

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 1);
  });

  it('3. One active ride -> 1', async () => {
    const customerId = await createCustomer();
    const { driverId, vehicleId, vehicleTypeId } = await createDriverWithVehicle();
    const requestId = await insertRequest(customerId, vehicleTypeId, 'MATCHED');
    await insertRide(requestId, customerId, driverId, vehicleId, vehicleTypeId, 'IN_PROGRESS');

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 1);
  });

  it('4. Multiple searching riders -> correct count (3)', async () => {
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    const c1 = await createCustomer();
    const c2 = await createCustomer();
    const c3 = await createCustomer();

    await insertRequest(c1, vehicleTypeId, 'SEARCHING');
    await insertRequest(c2, vehicleTypeId, 'SEARCHING');
    await insertRequest(c3, vehicleTypeId, 'SEARCHING');

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 3);
  });

  it('5. Multiple ongoing riders in different ride statuses -> correct count (4)', async () => {
    const statuses: Array<'ACCEPTED' | 'DRIVER_ARRIVING' | 'DRIVER_ARRIVED' | 'IN_PROGRESS'> = [
      'ACCEPTED',
      'DRIVER_ARRIVING',
      'DRIVER_ARRIVED',
      'IN_PROGRESS',
    ];

    for (const status of statuses) {
      const { driverId, vehicleId, vehicleTypeId } = await createDriverWithVehicle();
      const c = await createCustomer();
      const reqId = await insertRequest(c, vehicleTypeId, 'MATCHED');
      await insertRide(reqId, c, driverId, vehicleId, vehicleTypeId, status);
    }

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 4);
  });

  it('6. Same customer in request + ride -> counted once (1)', async () => {
    const customerId = await createCustomer();
    const { driverId, vehicleId, vehicleTypeId } = await createDriverWithVehicle();

    // Customer has an active request AND an ongoing ride
    await insertRequest(customerId, vehicleTypeId, 'SEARCHING');
    const matchedReq = await insertRequest(customerId, vehicleTypeId, 'MATCHED');
    await insertRide(matchedReq, customerId, driverId, vehicleId, vehicleTypeId, 'ACCEPTED');

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 1, 'Same customer across ride and request must be deduplicated to 1');
  });

  it('7. Expired SEARCHING request (expires_at in past) -> not counted (0)', async () => {
    const customerId = await createCustomer();
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    const past = new Date(Date.now() - 60 * 1000); // 1 minute in the past
    await insertRequest(customerId, vehicleTypeId, 'SEARCHING', past);

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 0, 'Expired search request must not be counted');
  });

  it('8. CREATED request with future expiry -> counted (1)', async () => {
    const customerId = await createCustomer();
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    const future = new Date(Date.now() + 10 * 60 * 1000);
    await insertRequest(customerId, vehicleTypeId, 'CREATED', future);

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 1);
  });

  it('9. Completed ride -> not counted (0)', async () => {
    const customerId = await createCustomer();
    const { driverId, vehicleId, vehicleTypeId } = await createDriverWithVehicle();
    const reqId = await insertRequest(customerId, vehicleTypeId, 'MATCHED');
    await insertRide(reqId, customerId, driverId, vehicleId, vehicleTypeId, 'COMPLETED');

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 0);
  });

  it('10. Cancelled ride -> not counted (0)', async () => {
    const customerId = await createCustomer();
    const { driverId, vehicleId, vehicleTypeId } = await createDriverWithVehicle();
    const reqId = await insertRequest(customerId, vehicleTypeId, 'MATCHED');
    await insertRide(
      reqId,
      customerId,
      driverId,
      vehicleId,
      vehicleTypeId,
      'CANCELLED_BY_CUSTOMER',
    );

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 0);
  });

  it('11. Multiple active rides for different customers -> correct distinct count (3)', async () => {
    const d1 = await createDriverWithVehicle();
    const d2 = await createDriverWithVehicle();
    const d3 = await createDriverWithVehicle();

    const c1 = await createCustomer();
    const c2 = await createCustomer();
    const c3 = await createCustomer();

    const r1 = await insertRequest(c1, d1.vehicleTypeId, 'MATCHED');
    const r2 = await insertRequest(c2, d2.vehicleTypeId, 'MATCHED');
    const r3 = await insertRequest(c3, d3.vehicleTypeId, 'MATCHED');

    await insertRide(r1, c1, d1.driverId, d1.vehicleId, d1.vehicleTypeId, 'ACCEPTED');
    await insertRide(r2, c2, d2.driverId, d2.vehicleId, d2.vehicleTypeId, 'DRIVER_ARRIVING');
    await insertRide(r3, c3, d3.driverId, d3.vehicleId, d3.vehicleTypeId, 'IN_PROGRESS');

    const count = await dashboardService.getInFlightRidersCount();
    assert.equal(count, 3);
  });

  it('12. Existing ongoingRides metric remains correct independently of inFlightRiders', async () => {
    const { driverId, vehicleId, vehicleTypeId } = await createDriverWithVehicle();
    const c1 = await createCustomer();
    const c2 = await createCustomer();

    // c1 is searching
    await insertRequest(c1, vehicleTypeId, 'SEARCHING');
    // c2 is in a ride
    const req2 = await insertRequest(c2, vehicleTypeId, 'MATCHED');
    await insertRide(req2, c2, driverId, vehicleId, vehicleTypeId, 'IN_PROGRESS');

    const stats = await dashboardService.getStats();
    assert.equal(stats.stats.ongoingRides, 1, 'ongoingRides counts actual active rides only');
    assert.equal(
      stats.stats.inFlightRiders,
      2,
      'inFlightRiders counts c1 (searching) + c2 (riding)',
    );
  });

  it('13. Dashboard API returns the correct contract with inFlightRiders and activeRiders alias', async () => {
    const { authorization } = await loginAdmin();
    const customerId = await createCustomer();
    const vehicleTypeId = await vehicleTypeIdByCode('AUTO');
    await insertRequest(customerId, vehicleTypeId, 'SEARCHING');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(typeof body.stats.inFlightRiders, 'number');
    assert.equal(typeof body.stats.activeRiders, 'number');
    assert.equal(body.stats.inFlightRiders, 1);
    assert.equal(body.stats.activeRiders, 1);
  });

  it('14. Unauthenticated request remains rejected (401)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
    });
    assert.equal(response.statusCode, 401);
  });

  it('15. Authorized admin receives the metric correctly (200)', async () => {
    const { authorization } = await loginAdmin();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/stats',
      headers: { authorization },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok('inFlightRiders' in body.stats);
    assert.ok('activeRiders' in body.stats);
  });

  it('Performance Verification: EXPLAIN ANALYZE on in-flight riders query', async () => {
    const rows = await db().client.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT COUNT(DISTINCT customer_id)::int AS count
      FROM (
        SELECT r."customer_id"
        FROM "rides" r
        WHERE r."status" IN (
          'ACCEPTED'::"RideStatus",
          'DRIVER_ARRIVING'::"RideStatus",
          'DRIVER_ARRIVED'::"RideStatus",
          'IN_PROGRESS'::"RideStatus"
        )

        UNION

        SELECT rr."customer_id"
        FROM "ride_requests" rr
        WHERE rr."status" IN (
          'CREATED'::"RideRequestStatus",
          'SEARCHING'::"RideRequestStatus"
        )
        AND (
          rr."expires_at" IS NULL
          OR rr."expires_at" > NOW()
        )
      ) active_customers;
    `);

    const planLines = rows.map((r) => r['QUERY PLAN']);
    console.warn('--- ACTUAL EXPLAIN ANALYZE OUTPUT ---');
    console.warn(planLines.join('\n'));
    console.warn('------------------------------------');

    assert.ok(planLines.length > 0);
  });
});
