import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCity, ensureServiceZone, grantRole } from './helpers/fixtures.js';
import { completeRide, rideWorld } from './helpers/ride-flow.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import type { PricingService } from '../../src/modules/pricing/services/pricing.service.js';
import type { PricingSnapshot } from '../../src/modules/pricing/domain/pricing.types.js';

const ADMIN_PHONE = '+919876618001';
const ADMIN_EMAIL = 'phase1-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const CUSTOMER_PHONE = '+919876618002';
const DRIVER_PHONE = '+919876618003';

const SGR_POLYGON: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

describe('Phase 1 — Core Fare Engine (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
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
    await grantRole(seed.userId, 'system_admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return { authorization: `Bearer ${res.json().accessToken as string}` };
  }

  async function anyCarType() {
    return db().client.vehicleType.findFirstOrThrow({
      where: { category: 'car', isActive: true },
    });
  }

  it('1.1 time-aware scheduling closes incumbent effectiveTo without deactivating live rule, and warns on gaps', async () => {
    const headers = await loginAdmin();
    const car = await anyCarType();
    await ensureCity('SGR', 'Srinagar', 'Jammu & Kashmir');

    const lastYear = `${new Date().getFullYear() - 1}-01-01`;
    const nextYear = `${new Date().getFullYear() + 1}-06-01`;
    const yearAfter = `${new Date().getFullYear() + 2}-01-01`;

    const liveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'SGR',
        baseFare: 50,
        minimumFare: 70,
        perKmRate: 12,
        perMinuteRate: 1.5,
        effectiveFrom: lastYear,
      },
    });
    assert.equal(liveRes.statusCode, 201, liveRes.payload);
    const liveId = liveRes.json().data.id as string;

    // Schedule future rule on the same key — incumbent must STAY active and end at nextYear!
    // Scheduled through an edit of the live rule: create refuses a second active
    // overlapping rule (FARE_RULE_CONFLICT) and says to edit the incumbent instead.
    const futureRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fare-rules/${liveId}`,
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'SGR',
        baseFare: 65,
        minimumFare: 90,
        perKmRate: 14,
        perMinuteRate: 2,
        effectiveFrom: nextYear,
        effectiveTo: `${new Date().getFullYear() + 1}-09-01`,
      },
    });
    assert.equal(futureRes.statusCode, 200, futureRes.payload);
    assert.equal(futureRes.json().data.status, 'active');

    const incumbentRow = await db().client.pricingRule.findUniqueOrThrow({ where: { id: liveId } });
    assert.equal(incumbentRow.isActive, true, 'live rule must remain active until handoff');
    assert.equal(
      incumbentRow.effectiveTo?.toISOString().slice(0, 10),
      nextYear,
      'incumbent effectiveTo must be closed at successor start',
    );

    // Scheduling a third rule after a gap emits FARE_RULE_GAP warning
    const gapRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'SGR',
        baseFare: 75,
        minimumFare: 100,
        perKmRate: 16,
        perMinuteRate: 2,
        effectiveFrom: yearAfter,
      },
    });
    assert.equal(gapRes.statusCode, 201, gapRes.payload);
    const warnings = gapRes.json().data.warnings as Array<{ code: string }>;
    assert.ok(Array.isArray(warnings) && warnings.some((w) => w.code === 'FARE_RULE_GAP'));
  });

  it('1.2 & 1.3 enforces strict schema, null-inherit clear, expectedVersion 409 FARE_RULE_STALE, and versions history', async () => {
    const headers = await loginAdmin();
    const car = await anyCarType();
    const nextYear = `${new Date().getFullYear() + 1}-01-01`;
    // resetState seeds an open-ended GLOBAL card for this type. Deleted, not
    // retired: a key with history makes the next create v2 of that family, and
    // this test is about a fresh v1 lineage.
    await db().client.pricingRule.deleteMany({
      where: { vehicleTypeId: car.id, cityCode: 'GLOBAL' },
    });

    // Reject unknown field (.strict())
    const badExtra = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'GLOBAL',
        baseFare: 50,
        minimumFare: 60,
        perKmRate: 10,
        perMinuteRate: 1,
        effectiveFrom: nextYear,
        unknownGarbageField: true,
      },
    });
    assert.equal(badExtra.statusCode, 400, badExtra.payload);

    // Reject effectiveTo <= effectiveFrom
    const badRange = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'GLOBAL',
        baseFare: 50,
        minimumFare: 60,
        perKmRate: 10,
        perMinuteRate: 1,
        effectiveFrom: nextYear,
        effectiveTo: nextYear,
      },
    });
    assert.equal(badRange.statusCode, 400, badRange.payload);

    // Create v1 with explicit taxRatePct = 12
    const v1Res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'GLOBAL',
        baseFare: 50,
        minimumFare: 60,
        perKmRate: 10,
        perMinuteRate: 1,
        taxRatePct: 12,
        effectiveFrom: nextYear,
      },
    });
    assert.equal(v1Res.statusCode, 201, v1Res.payload);
    const v1 = v1Res.json().data;
    assert.equal(v1.version, 1);
    assert.equal(v1.taxRatePct, 12);
    assert.equal(v1.ruleFamilyId, v1.id);

    // Update to v2 with expectedVersion: 1 and taxRatePct: null (explicit inherit!)
    const v2Res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fare-rules/${v1.id as string}`,
      headers,
      payload: {
        baseFare: 55,
        taxRatePct: null,
        expectedVersion: 1,
      },
    });
    assert.equal(v2Res.statusCode, 200, v2Res.payload);
    const v2 = v2Res.json().data;
    assert.equal(v2.version, 2);
    assert.equal(v2.taxRatePct, null, 'explicit null must clear override to inherit default');
    assert.equal(v2.ruleFamilyId, v1.ruleFamilyId);
    assert.equal(v2.supersedesId, v1.id);

    // Stale expectedVersion on v1 or v2 must fail with 409 FARE_RULE_STALE
    const staleRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fare-rules/${v2.id as string}`,
      headers,
      payload: { baseFare: 60, expectedVersion: 1 },
    });
    assert.equal(staleRes.statusCode, 409, staleRes.payload);
    assert.equal(staleRes.json().error.code, 'FARE_RULE_STALE');

    // Version history endpoint returns [v2, v1]
    const versionsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/fare-rules/${v2.id as string}/versions`,
      headers,
    });
    assert.equal(versionsRes.statusCode, 200, versionsRes.payload);
    const versions = versionsRes.json().data as Array<{ id: string; version: number }>;
    assert.equal(versions.length, 2);
    assert.deepEqual(
      versions.map((r) => r.version),
      [2, 1],
    );
  });

  it('1.4 & 1.5 persists quote lock (5m TTL), enforces reuse/expiry/fare-changed 409, and enforces write-once pricing_snapshot', async () => {
    const w = await rideWorld(app, { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE });
    const pickup = { pickupLat: 34.0837, pickupLng: 74.7973 };
    const drop = { dropLat: 34.12, dropLng: 74.83 };

    const quoteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/quote',
      headers: w.customer.authHeader,
      payload: { ...pickup, ...drop, vehicleTypeId: w.vehicleTypeId },
    });
    assert.equal(quoteRes.statusCode, 200, quoteRes.payload);
    const quoteData = quoteRes.json().data;
    assert.ok(quoteData.quoteId, 'quote must persist and return quoteId');
    assert.ok(quoteData.expiresAt, 'quote must return expiresAt');
    const ttlSec = (new Date(quoteData.expiresAt).getTime() - Date.now()) / 1000;
    assert.ok(ttlSec > 240 && ttlSec <= 310, `expected ~300s TTL, got ${ttlSec}s`);

    const option = quoteData.options[0];
    assert.ok(option.waitingPolicy, 'quote option includes waitingPolicy');
    assert.ok(option.surge, 'quote option includes surge object');
    assert.equal(
      option.fareBreakdown.driverEarning,
      undefined,
      'customer quote must never leak driverEarning',
    );
    assert.equal(
      option.fareBreakdown.platformCommission,
      undefined,
      'customer quote must never leak platformCommission',
    );

    // Mismatched expectedFare returns 409 FARE_CHANGED
    const driftRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        ...pickup,
        ...drop,
        vehicleTypeId: w.vehicleTypeId,
        paymentMethod: 'CASH',
        quoteId: quoteData.quoteId,
        expectedFare: Number(option.estimatedFare) + 50,
      },
    });
    assert.equal(driftRes.statusCode, 409, driftRes.payload);
    assert.equal(driftRes.json().error.code, 'FARE_CHANGED');

    // Booking with valid quoteId succeeds and writes pricing_snapshot
    const bookRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        ...pickup,
        ...drop,
        vehicleTypeId: w.vehicleTypeId,
        paymentMethod: 'CASH',
        quoteId: quoteData.quoteId,
        expectedFare: Number(option.estimatedFare),
      },
    });
    assert.equal(bookRes.statusCode, 200, bookRes.payload);
    const requestId = bookRes.json().data.id as string;

    const reqRow = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
    assert.equal(reqRow.quoteId, quoteData.quoteId);
    assert.ok(reqRow.pricingSnapshot, 'ride_requests.pricing_snapshot must be written');

    // Write-once DB trigger must reject mutating pricing_snapshot once non-NULL (Rev 5 R5-5)
    await assert.rejects(
      () =>
        db().client.$executeRaw`
          UPDATE "ride_requests"
          SET "pricing_snapshot" = '{"tampered":true}'::jsonb
          WHERE "id" = ${requestId}::uuid
        `,
      /immutable/i,
    );

    // PricingService.calculateFinalFare prefers pricingSnapshot.rateCard over live rules
    const pricing = container.resolve<PricingService>('pricingService');
    const customSnap: PricingSnapshot = {
      ...(reqRow.pricingSnapshot as unknown as PricingSnapshot),
      rateCard: {
        baseFare: 99,
        perKm: 10,
        perMinute: 1,
        perWaitingMinute: 0,
        freeWaitingMin: 3,
        bookingFee: 0,
        platformFeePct: 0,
        platformFeeFlat: 0,
        taxRatePct: 0,
        commissionRatePct: 7,
        minimumFare: 99,
      },
    };
    const snappedFare = await pricing.calculateFinalFare({
      actualDistanceKm: 5,
      actualDurationMin: 10,
      vehicleTypeId: w.vehicleTypeId,
      pricingSnapshot: customSnap,
    });
    assert.equal(snappedFare.baseFare, 99);
    assert.equal(snappedFare.totalFare, 159);

    // Cancel request so customer can try reusing the already-consumed quoteId -> 409 QUOTE_ALREADY_USED
    await app.inject({
      method: 'POST',
      url: `/api/v1/rides/requests/${requestId}/cancel`,
      headers: w.customer.authHeader,
    });
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        ...pickup,
        ...drop,
        vehicleTypeId: w.vehicleTypeId,
        paymentMethod: 'CASH',
        quoteId: quoteData.quoteId,
      },
    });
    assert.equal(reuseRes.statusCode, 409, reuseRes.payload);
    assert.equal(reuseRes.json().error.code, 'QUOTE_ALREADY_USED');

    // Expired quote -> 409 QUOTE_EXPIRED
    const quote2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/quote',
      headers: w.customer.authHeader,
      payload: { ...pickup, ...drop, vehicleTypeId: w.vehicleTypeId },
    });
    const quote2Id = quote2Res.json().data.quoteId as string;
    await db().client.rideQuote.update({
      where: { id: quote2Id },
      data: { expiresAt: new Date(Date.now() - 5000) },
    });
    const expiredRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        ...pickup,
        ...drop,
        vehicleTypeId: w.vehicleTypeId,
        paymentMethod: 'CASH',
        quoteId: quote2Id,
      },
    });
    assert.equal(expiredRes.statusCode, 409, expiredRes.payload);
    assert.equal(expiredRes.json().error.code, 'QUOTE_EXPIRED');
  });

  it('1.6 & 1.7 splits customer vs driver DTO (no commission leak) and issues receipt only on completion', async () => {
    const w = await rideWorld(app, { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE });
    const { rideId } = await completeRide(app, w, {
      distanceKm: 6,
      durationMin: 15,
      paymentMethod: 'CASH',
    });

    // Receipt exists IMMEDIATELY after cash completion (without draining outbox)
    const receiptRow = await db().client.rideReceipt.findUnique({ where: { rideId } });
    assert.ok(receiptRow, 'cash ride receipt must be generated inside completion tx');
    const snap = receiptRow.snapshotJson as Record<string, unknown>;
    const fare = (snap.fare ?? {}) as Record<string, unknown>;
    assert.equal(fare.driverEarning, undefined, 'receipt must not expose driverEarning');
    assert.equal(fare.platformCommission, undefined, 'receipt must not expose platformCommission');

    // Customer GET /rides/:id must strip driver economics and never alias platformCommission into platformFee
    const custRide = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: w.customer.authHeader,
    });
    assert.equal(custRide.statusCode, 200, custRide.payload);
    const custData = custRide.json().data;
    assert.equal(custData.commissionAmount, undefined);
    assert.equal(custData.driverPaymentModel, undefined);
    assert.equal(custData.fare.driverEarning, undefined);
    assert.equal(custData.fare.platformCommission, undefined);

    // Driver GET /rides/:id DOES receive driverEarning & platformCommission
    const drvRide = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}`,
      headers: w.driver.authHeader,
    });
    assert.equal(drvRide.statusCode, 200, drvRide.payload);
    const drvData = drvRide.json().data;
    assert.equal(typeof drvData.fare.driverEarning, 'number');
    assert.equal(typeof drvData.fare.platformCommission, 'number');
    // And platformFee is NOT equal to platformCommission (alias removed)
    const storedFare = await db().client.rideFare.findUniqueOrThrow({ where: { rideId } });
    assert.equal(drvData.fare.platformFee, Number(storedFare.platformFee));
    assert.equal(custData.fare.platformFee, Number(storedFare.platformFee));
  });

  it('1.8 POST /admin/pricing/simulate resolves live rule and simulates future scheduled rules', async () => {
    const headers = await loginAdmin();
    const car = await anyCarType();
    await ensureCity('SGR', 'Srinagar', 'Jammu & Kashmir');
    await ensureServiceZone('SGR', 'SGR_CORE', 'SGR Core', SGR_POLYGON);

    const lastYear = `${new Date().getFullYear() - 1}-01-01`;
    const nextYear = `${new Date().getFullYear() + 1}-01-01`;

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'SGR',
        baseFare: 40,
        minimumFare: 60,
        perKmRate: 10,
        perMinuteRate: 1,
        platformFeeFlat: 0,
        taxRatePct: 0,
        effectiveFrom: lastYear,
      },
    });
    assert.equal(r1.statusCode, 201, r1.payload);

    // Scheduled as an edit of r1 (create refuses an overlapping active rule).
    const r2 = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fare-rules/${r1.json().data.id as string}`,
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'SGR',
        baseFare: 80,
        minimumFare: 100,
        perKmRate: 20,
        perMinuteRate: 2,
        platformFeeFlat: 0,
        taxRatePct: 0,
        effectiveFrom: nextYear,
      },
    });
    assert.equal(r2.statusCode, 200, r2.payload);

    // Simulate NOW -> resolves r1 (40 + 5*10 + 10*1 = 100)
    const simNow = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/pricing/simulate',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'SGR',
        distanceKm: 5,
        durationMin: 10,
      },
    });
    assert.equal(simNow.statusCode, 200, simNow.payload);
    assert.equal(simNow.json().data.resolvedRule.id, r1.json().data.id);
    assert.equal(simNow.json().data.fare.totalFare, 100);

    // Simulate NEXT YEAR -> resolves r2 (80 + 5*20 + 10*2 = 200)
    const simFuture = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/pricing/simulate',
      headers,
      payload: {
        vehicleTypeId: car.id,
        cityCode: 'SGR',
        distanceKm: 5,
        durationMin: 10,
        at: `${new Date().getFullYear() + 1}-02-01T12:00:00.000Z`,
      },
    });
    assert.equal(simFuture.statusCode, 200, simFuture.payload);
    assert.equal(simFuture.json().data.resolvedRule.id, r2.json().data.id);
    assert.equal(simFuture.json().data.fare.totalFare, 200);
  });
});
