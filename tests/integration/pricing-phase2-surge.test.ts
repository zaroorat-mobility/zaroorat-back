import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCity, ensureCityWithBoundary, ensureServiceZone, grantRole } from './helpers/fixtures.js';
import { rideWorld } from './helpers/ride-flow.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import type { PricingService } from '../../src/modules/pricing/services/pricing.service.js';

const ADMIN_PHONE = '+919876629001';
const ADMIN_EMAIL = 'phase2-surge-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const CUSTOMER_PHONE = '+919876629002';
const DRIVER_PHONE = '+919876629003';

describe('Phase 2 — Surge Rules, Multi-Vehicle, Citywide, End-and-Replace & D-08 Base (integration)', () => {
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

  it('2.2 (D-08) applies surge strictly to Base+Distance+Time and NEVER surges waiting or booking fee', async () => {
    const pricing = container.resolve<PricingService>('pricingService');
    // Rev 5 §4.2 exact worked example:
    // Base 30 + 8km*10 (80) + 20min*1 (20) = 130.00 -> 1.2x surge = +26.00
    // Waiting: 5min - 3 free = 2min * 1 = 2.00 (unsurged!)
    // Booking fee: 10.00 (unsurged!)
    // Subtotal = 130 + 26 + 2 + 10 = 168.00
    const result = await pricing.calculateFinalFare({
      actualDistanceKm: 8,
      actualDurationMin: 20,
      waitingMinutes: 5,
      surgeMultiplier: 1.2,
      vehicleTypeId: '',
      rateCard: {
        baseFare: 30,
        perKm: 10,
        perMinute: 1,
        freeWaitingMin: 3,
        perWaitingMinute: 1,
        bookingFee: 10,
        platformFeePct: 0,
        platformFeeFlat: 0,
        taxRatePct: 0,
        commissionRatePct: 7,
        minimumFare: 60,
      },
    });
    assert.equal(result.surgeAmount, 26, 'surge must apply only to 30+80+20=130 -> 26');
    assert.equal(result.waitingCharge, 2);
    assert.equal(result.bookingFee, 10);
    assert.equal(result.subtotal, 168);
    assert.equal(result.totalFare, 168);
  });

  it('2.3 & 2.4 creates multi-vehicle citywide window, end-and-replaces on edit, lists versions, and returns coded 404s', async () => {
    const headers = await loginAdmin();
    await ensureCity('SGR', 'Srinagar', 'Jammu & Kashmir');
    const types = await db().client.vehicleType.findMany({
      where: { isActive: true },
      take: 2,
    });
    assert.equal(types.length, 2);
    const [vtA, vtB] = types;

    // Create a citywide multi-vehicle window in ONE atomic request (no zoneId needed)
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/surge-windows',
      headers,
      payload: {
        cityCode: 'SGR',
        vehicleTypeIds: [vtA!.id, vtB!.id],
        multiplier: 1.4,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'Heavy Snowfall Citywide',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const v1 = created.json().data;
    assert.equal(v1.cityCode, 'SGR');
    assert.equal(v1.zoneName, 'SGR (Citywide)');
    assert.deepEqual(new Set(v1.vehicleTypeIds), new Set([vtA!.id, vtB!.id]));
    assert.equal(v1.vehicleTypes.length, 2);
    assert.equal(v1.vehicleTypeId, null, 'multi-vehicle window keeps single legacy column null');

    // Editing multiplier triggers end-and-replace: v1 deactivated, v2 created with supersedesId = v1.id
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/surge-windows/${v1.id as string}`,
      headers,
      payload: { multiplier: 1.6, reason: 'Peak Snowfall Escalation' },
    });
    assert.equal(edited.statusCode, 200, edited.payload);
    const v2 = edited.json().data;
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.supersedesId, v1.id);
    assert.equal(Number(v2.multiplier), 1.6);

    const v1Db = await db().client.surgeWindow.findUniqueOrThrow({ where: { id: v1.id } });
    assert.equal(v1Db.isActive, false, 'incumbent window must be retired on edit');

    // Revision history endpoint returns [v2, v1]
    const versionsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/surge-windows/${v2.id as string}/versions`,
      headers,
    });
    assert.equal(versionsRes.statusCode, 200, versionsRes.payload);
    const versions = versionsRes.json().data as Array<{ id: string }>;
    assert.deepEqual(
      versions.map((r) => r.id),
      [v2.id, v1.id],
    );

    // Coded 404 for unknown window and zone
    const missingWin = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/surge-windows/00000000-0000-7000-8000-000000000000',
      headers,
    });
    assert.equal(missingWin.statusCode, 404);
    assert.equal(missingWin.json().error.code, 'SURGE_WINDOW_NOT_FOUND');

    const missingZone = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/surge-zones/00000000-0000-7000-8000-000000000000',
      headers,
    });
    assert.equal(missingZone.statusCode, 404);
    assert.equal(missingZone.json().error.code, 'SURGE_ZONE_NOT_FOUND');
  });

  it('2.3 records surge_window_id on quote options, ride_requests, and pricing_snapshot, and discloses reason label', async () => {
    const headers = await loginAdmin();
    const w = await rideWorld(app, { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE });
    const sgrBounds: number[][][] = [
      [
        [74.7, 34.0],
        [75.0, 34.0],
        [75.0, 34.2],
        [74.7, 34.2],
        [74.7, 34.0],
      ],
    ];
    await ensureCityWithBoundary('SGR', 'Srinagar', sgrBounds);
    await ensureServiceZone('SGR', 'SGR_CITY', 'Srinagar City', sgrBounds);

    // Create active citywide surge window in SGR for the rideWorld vehicle type
    const winRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/surge-windows',
      headers,
      payload: {
        cityCode: 'SGR',
        vehicleTypeIds: [w.vehicleTypeId],
        multiplier: 1.5,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'Evening Rush Hour',
      },
    });
    assert.equal(winRes.statusCode, 201, winRes.payload);
    const winId = winRes.json().data.id as string;

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
    const opt = quoteData.options[0];
    assert.equal(opt.surge.multiplier, 1.5);
    assert.equal(opt.surge.windowId, winId);
    assert.equal(opt.surge.label, 'Evening Rush Hour');

    // Book with quoteId -> ride_requests.surge_window_id & pricing_snapshot.surgeWindowId persisted!
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
      },
    });
    assert.equal(bookRes.statusCode, 200, bookRes.payload);
    const reqRow = await db().client.rideRequest.findUniqueOrThrow({
      where: { id: bookRes.json().data.id as string },
    });
    assert.equal(reqRow.surgeWindowId, winId);
    assert.equal((reqRow.pricingSnapshot as Record<string, unknown>).surgeWindowId, winId);
  });
});
