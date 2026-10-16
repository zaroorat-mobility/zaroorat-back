interface PromoResponseItem {
  id: string;
  code: string;
  title: string | null;
  description: string | null;
  discountType: string;
  discountValue: number;
  maxDiscount: number | null;
  minFare: number;
  discountDisplay: string;
  isCoupon: boolean;
}
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, resetState } from './helpers/harness.js';
import { rideWorld, bookRideRequest, acceptRide } from './helpers/ride-flow.js';
import { RIDE_PIN } from './helpers/fixtures.js';
import type { DriverLocationRepository } from '../../src/modules/drivers/repositories/driver-location.repository.js';
import { container } from '../../src/core/di.js';
import type { DatabaseService } from '../../src/core/database/index.js';

describe('customer promotions read and available APIs (integration)', () => {
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

  it('lists active HOME banners and excludes inactive or expired ones', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540201',
      driver: '+919876540202',
    });
    const db = container.resolve<DatabaseService>('databaseService').client;

    const file = await db.file.create({
      data: {
        ownerUserId: world.customer.userId,
        purpose: 'PROMO_BANNER',
        status: 'READY',
        storageKey: 'banners/home_test_1.png',
        storageProvider: 'local',
        fileName: 'home_test_1.png',
        contentType: 'image/png',
        sizeBytes: 1024,
        completedAt: new Date(),
        uploadExpiresAt: new Date(Date.now() + 86400000),
      },
    });

    const file2 = await db.file.create({
      data: {
        ownerUserId: world.customer.userId,
        purpose: 'PROMO_BANNER',
        status: 'READY',
        storageKey: 'banners/home_test_2.png',
        storageProvider: 'local',
        fileName: 'home_test_2.png',
        contentType: 'image/png',
        sizeBytes: 1024,
        completedAt: new Date(),
        uploadExpiresAt: new Date(Date.now() + 86400000),
      },
    });

    const activeBanner = await db.promoBanner.create({
      data: {
        title: 'Monsoon Savings',
        imageFileId: file.id,
        placement: 'HOME',
        priority: 10,
        actionUrl: 'https://zaroorat.app/offers/monsoon',
        isActive: true,
      },
    });

    await db.promoBanner.create({
      data: {
        title: 'Disabled Banner',
        imageFileId: file2.id,
        placement: 'HOME',
        priority: 5,
        isActive: false,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions/home',
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.data));
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, activeBanner.id);
    assert.equal(body.data[0].title, 'Monsoon Savings');
    assert.equal(body.data[0].actionUrl, 'https://zaroorat.app/offers/monsoon');
    assert.equal(body.data[0].priority, 10);
  });

  it('lists available promotions and user-assigned coupons, rejecting expired or exhausted', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540203',
      driver: '+919876540204',
    });
    const db = container.resolve<DatabaseService>('databaseService').client;

    // 1. Unauthenticated call gets 401
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions/available',
    });
    assert.equal(unauthRes.statusCode, 401);

    const future = new Date(Date.now() + 7 * 86400000);
    const past = new Date(Date.now() - 7 * 86400000);

    // Active promo: Flat 50
    await db.promotion.create({
      data: {
        code: 'ZAROORAT50',
        title: 'Flat ₹50 OFF',
        description: 'Save on any ride',
        discountType: 'FIXED',
        discountValue: 50,
        minFare: 50,
        validFrom: past,
        validTo: future,
        isActive: true,
      },
    });

    // Inactive promo
    await db.promotion.create({
      data: {
        code: 'INACTIVE20',
        title: '20% OFF',
        discountType: 'PERCENT',
        discountValue: 20,
        validFrom: past,
        validTo: future,
        isActive: false,
      },
    });

    // Expired promo
    await db.promotion.create({
      data: {
        code: 'EXPIRED10',
        title: '10% OFF',
        discountType: 'PERCENT',
        discountValue: 10,
        validFrom: new Date(Date.now() - 14 * 86400000),
        validTo: past,
        isActive: true,
      },
    });

    // Exhausted promo
    await db.promotion.create({
      data: {
        code: 'MAXED100',
        title: '₹100 OFF',
        discountType: 'FIXED',
        discountValue: 100,
        usageLimitTotal: 1,
        usedCount: 1,
        validFrom: past,
        validTo: future,
        isActive: true,
      },
    });

    // Coupon batch & assigned coupon
    const couponPromo = await db.promotion.create({
      data: {
        code: 'COUPON_BASE',
        title: 'Special Coupon 25%',
        discountType: 'PERCENT',
        discountValue: 25,
        maxDiscount: 75,
        validFrom: past,
        validTo: future,
        isActive: true,
      },
    });

    const batch = await db.couponBatch.create({
      data: {
        promotionId: couponPromo.id,
        name: 'Welcome Coupons',
        isActive: true,
      },
    });

    await db.coupon.create({
      data: {
        batchId: batch.id,
        code: 'SPECIAL25',
        userId: world.customer.userId,
        status: 'ASSIGNED',
      },
    });

    // Other user coupon
    await db.coupon.create({
      data: {
        batchId: batch.id,
        code: 'OTHERUSER25',
        userId: world.driver.userId,
        status: 'ASSIGNED',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions/available',
      headers: world.customer.authHeader,
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.data));

    const codes = body.data.map((p: PromoResponseItem) => p.code);
    assert.ok(codes.includes('ZAROORAT50'), 'Active promo ZAROORAT50 should be present');
    assert.ok(codes.includes('SPECIAL25'), 'Assigned coupon SPECIAL25 should be present');
    assert.ok(!codes.includes('INACTIVE20'), 'Inactive promo should not be present');
    assert.ok(!codes.includes('EXPIRED10'), 'Expired promo should not be present');
    assert.ok(!codes.includes('MAXED100'), 'Exhausted promo should not be present');
    assert.ok(!codes.includes('OTHERUSER25'), 'Other user coupon should not be present');

    const zaroorat50 = body.data.find((p: PromoResponseItem) => p.code === 'ZAROORAT50');
    assert.equal(zaroorat50.discountType, 'FIXED');
    assert.equal(zaroorat50.discountValue, 50);
    assert.equal(zaroorat50.discountDisplay, 'Flat ₹50 OFF');
    assert.equal(zaroorat50.isCoupon, false);

    const special25 = body.data.find((p: PromoResponseItem) => p.code === 'SPECIAL25');
    assert.equal(special25.discountType, 'PERCENT');
    assert.equal(special25.discountValue, 25);
    assert.equal(special25.maxDiscount, 75);
    assert.equal(special25.discountDisplay, '25% OFF up to ₹75');
    assert.equal(special25.isCoupon, true);
  });

  it('enforces first-ride only restrictions dynamically against completed rides', async () => {
    const world = await rideWorld(app, {
      customer: '+919876540205',
      driver: '+919876540206',
    });
    const db = container.resolve<DatabaseService>('databaseService').client;

    const future = new Date(Date.now() + 7 * 86400000);
    const past = new Date(Date.now() - 7 * 86400000);

    await db.promotion.create({
      data: {
        code: 'FIRSTRIDEFREE',
        title: 'First Ride 100% OFF',
        discountType: 'PERCENT',
        discountValue: 100,
        maxDiscount: 100,
        firstRideOnly: true,
        validFrom: past,
        validTo: future,
        isActive: true,
      },
    });

    // 1. With 0 completed rides, FIRSTRIDEFREE is available
    const initialRes = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions/available',
      headers: world.customer.authHeader,
    });
    assert.equal(initialRes.statusCode, 200);
    const initialCodes = initialRes.json().data.map((p: PromoResponseItem) => p.code);
    assert.ok(initialCodes.includes('FIRSTRIDEFREE'));

    // 2. Complete a real ride for this customer
    const reqId = await bookRideRequest(app, world, { distanceKm: 2 });
    const rideId = await acceptRide(app, world, reqId);
    const locRepo = container.resolve<DriverLocationRepository>('driverLocationRepository');
    await locRepo.updateLocation({
      driverId: world.driverId,
      latitude: 12.9716,
      longitude: 77.5946,
      heading: 0,
    });
    const arr = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/arrive`,
      headers: world.driver.authHeader,
      payload: {},
    });
    assert.equal(arr.statusCode, 200, arr.payload);
    const st = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: world.driver.authHeader,
      payload: { pin: RIDE_PIN },
    });
    assert.equal(st.statusCode, 200, st.payload);
    const dropLat = 12.9716 + 2 * 0.009;
    await locRepo.updateLocation({
      driverId: world.driverId,
      latitude: dropLat,
      longitude: 77.5946,
      heading: 0,
    });
    const comp = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/complete`,
      headers: world.driver.authHeader,
      payload: { actualDistanceKm: 2, actualDurationMin: 5 },
    });
    assert.equal(comp.statusCode, 200, comp.payload);

    // 3. Query available promotions again -> FIRSTRIDEFREE must now be excluded
    const afterRes = await app.inject({
      method: 'GET',
      url: '/api/v1/promotions/available',
      headers: world.customer.authHeader,
    });
    assert.equal(afterRes.statusCode, 200);
    const afterCodes = afterRes.json().data.map((p: PromoResponseItem) => p.code);
    assert.ok(
      !afterCodes.includes('FIRSTRIDEFREE'),
      'First ride only promo must be excluded once user has a completed ride',
    );
  });
});
