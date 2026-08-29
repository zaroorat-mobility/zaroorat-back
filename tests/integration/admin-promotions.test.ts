import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545101';
const ADMIN_EMAIL = 'promo-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin promotions (integration)', () => {
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
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return {
      authorization: `Bearer ${loggedIn.json().accessToken}`,
      adminUserId: seed.userId,
    };
  }

  async function seedPromoBannerFile(adminUserId: string): Promise<string> {
    const now = new Date();
    const file = await db().client.file.create({
      data: {
        ownerUserId: adminUserId,
        purpose: 'PROMO_BANNER',
        status: 'READY',
        storageKey: `pb/test/${randomUUID()}.png`,
        storageProvider: 'mock',
        fileName: 'banner.png',
        contentType: 'image/png',
        detectedContentType: 'image/png',
        sizeBytes: 512,
        scanStatus: 'SKIPPED',
        uploadExpiresAt: now,
        uploadedAt: now,
        verifiedAt: now,
        completedAt: now,
        scannedAt: now,
      },
    });
    return file.id;
  }

  it('creates promotion, campaign, segment, batch and reports', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const promoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promotions',
      headers: authHeader,
      payload: {
        code: 'RAIN20',
        title: 'Monsoon Discount',
        description: '20% off rides',
        discountType: 'PERCENT',
        discountValue: 20,
        maxDiscount: 50,
        minFare: 100,
        usageLimitTotal: 1000,
        usageLimitPerUser: 2,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
        isActive: true,
      },
    });
    assert.equal(promoRes.statusCode, 201, promoRes.payload);
    const promo = promoRes.json().data;
    assert.equal(promo.code, 'RAIN20');
    assert.equal(promo.discountType, 'PERCENT');

    const segmentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/segments',
      headers: authHeader,
      payload: {
        code: 'ALL_RIDERS',
        name: 'All riders',
        rules: { cityCodes: ['BLR'] },
      },
    });
    assert.equal(segmentRes.statusCode, 201, segmentRes.payload);
    const segment = segmentRes.json().data;

    const campaignRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns',
      headers: authHeader,
      payload: {
        code: 'MONSOON26',
        name: 'Monsoon Campaign',
        objective: 'ACQUISITION',
        status: 'RUNNING',
      },
    });
    assert.equal(campaignRes.statusCode, 201, campaignRes.payload);
    const campaign = campaignRes.json().data;

    const targetsRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/campaigns/${campaign.id}/targets`,
      headers: authHeader,
      payload: {
        targets: [{ segmentId: segment.id, promotionId: promo.id }],
      },
    });
    assert.equal(targetsRes.statusCode, 200, targetsRes.payload);
    assert.equal(targetsRes.json().data.targets.length, 1);

    const batchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/coupon-batches',
      headers: authHeader,
      payload: {
        promotionId: promo.id,
        campaignId: campaign.id,
        name: 'Monsoon batch',
        prefix: 'MN',
        totalCount: 5,
        generateNow: true,
      },
    });
    assert.equal(batchRes.statusCode, 201, batchRes.payload);
    assert.equal(batchRes.json().data.generatedCount, 5);

    const couponsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/coupons?batchId=${batchRes.json().data.id}`,
      headers: authHeader,
    });
    assert.equal(couponsRes.statusCode, 200, couponsRes.payload);
    assert.equal(couponsRes.json().data.length, 5);

    const bannerFileId = await seedPromoBannerFile(authHeader.adminUserId);
    const bannerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promo-banners',
      headers: authHeader,
      payload: {
        campaignId: campaign.id,
        title: 'Rain offer',
        imageFileId: bannerFileId,
        placement: 'HOME',
      },
    });
    assert.equal(bannerRes.statusCode, 201, bannerRes.payload);

    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/promotions/reports/overview',
      headers: authHeader,
    });
    assert.equal(overview.statusCode, 200, overview.payload);
    assert.equal(overview.json().data.totalUsage, 0);
    assert.equal(overview.json().data.activePromotions, 1);
  });

  it('activates/deactivates promotion and updates campaign budget/status', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const promoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promotions',
      headers: authHeader,
      payload: {
        title: 'Toggle promo',
        discountType: 'FIXED',
        discountValue: 25,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
        isActive: true,
      },
    });
    assert.equal(promoRes.statusCode, 201, promoRes.payload);
    const promoId = promoRes.json().data.id;
    assert.ok(promoRes.json().data.code);

    const deactivated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/promotions/${promoId}/deactivate`,
      headers: authHeader,
    });
    assert.equal(deactivated.statusCode, 200, deactivated.payload);
    assert.equal(deactivated.json().data.isActive, false);

    const activated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/promotions/${promoId}/activate`,
      headers: authHeader,
    });
    assert.equal(activated.statusCode, 200, activated.payload);
    assert.equal(activated.json().data.isActive, true);

    const campaignRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/campaigns',
      headers: authHeader,
      payload: {
        name: 'Budget Campaign',
        objective: 'RETENTION',
        status: 'DRAFT',
        budget: 50000,
        startsAt: now.toISOString(),
        endsAt: later.toISOString(),
      },
    });
    assert.equal(campaignRes.statusCode, 201, campaignRes.payload);
    const campaign = campaignRes.json().data;
    assert.equal(campaign.budget, 50000);
    assert.equal(campaign.status, 'DRAFT');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/campaigns/${campaign.id}`,
      headers: authHeader,
      payload: { status: 'SCHEDULED', budget: 75000 },
    });
    assert.equal(patched.statusCode, 200, patched.payload);
    assert.equal(patched.json().data.status, 'SCHEDULED');
    assert.equal(patched.json().data.budget, 75000);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/campaigns?status=SCHEDULED',
      headers: authHeader,
    });
    assert.equal(listed.statusCode, 200, listed.payload);
    assert.ok(listed.json().data.some((row: { id: string }) => row.id === campaign.id));
  });

  it('updates banner with relative action URL and replaced image file', async () => {
    const authHeader = await loginAdmin();
    const initialFileId = await seedPromoBannerFile(authHeader.adminUserId);
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promo-banners',
      headers: authHeader,
      payload: {
        title: 'Welcome hero',
        imageFileId: initialFileId,
        placement: 'HOME',
        actionUrl: '/offers/welcome',
      },
    });
    assert.equal(createRes.statusCode, 201, createRes.payload);
    const bannerId = createRes.json().data.id;

    const replacementFileId = await seedPromoBannerFile(authHeader.adminUserId);
    const updateRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/promo-banners/${bannerId}`,
      headers: authHeader,
      payload: {
        imageFileId: replacementFileId,
        actionUrl: '/offers/welcome',
      },
    });
    assert.equal(updateRes.statusCode, 200, updateRes.payload);
    assert.equal(updateRes.json().data.imageFileId, replacementFileId);
    assert.equal(updateRes.json().data.actionUrl, '/offers/welcome');
  });

  /// FR-020. `discountValue` had no upper bound and `maxDiscount` was optional
  /// regardless of type, so a percentage promotion could be created at 500% with
  /// no ceiling. `computeDiscountAmount` clamps to the subtotal, so the blast
  /// radius was "every ride free" rather than a negative fare — bounded, but by
  /// nothing anyone chose.
  it('refuses a percentage promotion with no ceiling or an impossible rate (FR-020)', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const base = {
      discountType: 'PERCENT',
      validFrom: now.toISOString(),
      validTo: later.toISOString(),
    };

    const uncapped = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promotions',
      headers: authHeader,
      payload: { ...base, code: 'NOCAP', discountValue: 20 },
    });
    assert.equal(uncapped.statusCode, 400, uncapped.payload);
    assert.match(uncapped.payload, /maximum discount/i);

    const overHundred = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promotions',
      headers: authHeader,
      payload: { ...base, code: 'TOOMUCH', discountValue: 500, maxDiscount: 50 },
    });
    assert.equal(overHundred.statusCode, 400, overHundred.payload);

    // A fixed-amount promotion is unaffected: it is already bounded by its own
    // value, so requiring a second ceiling would be noise.
    const fixed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promotions',
      headers: authHeader,
      payload: {
        code: 'FLAT50',
        discountType: 'FIXED',
        discountValue: 50,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
      },
    });
    assert.equal(fixed.statusCode, 201, fixed.payload);
  });

  /// FR-019. `Math.min(count, remaining || count)` collapsed to `count` once the
  /// batch was exhausted, because 0 is falsy, and `totalCount` was then raised to
  /// match whatever had been generated — so the cap was both unenforceable and
  /// self-erasing.
  it('refuses to generate beyond a coupon batch cap (FR-019)', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const promoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promotions',
      headers: authHeader,
      payload: {
        code: 'CAPPED',
        discountType: 'FIXED',
        discountValue: 25,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
      },
    });
    assert.equal(promoRes.statusCode, 201, promoRes.payload);

    const batchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/coupon-batches',
      headers: authHeader,
      payload: {
        promotionId: promoRes.json().data.id,
        name: 'Capped batch',
        prefix: 'CP',
        totalCount: 3,
        perUserLimit: 1,
        generateNow: true,
      },
    });
    assert.equal(batchRes.statusCode, 201, batchRes.payload);
    const batchId = batchRes.json().data.id;
    assert.equal(batchRes.json().data.generatedCount, 3);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/coupon-batches/${batchId}/generate`,
      headers: authHeader,
      payload: { count: 100 },
    });
    assert.equal(again.statusCode, 409, again.payload);
    assert.match(again.payload, /COUPON_BATCH_EXHAUSTED/);

    const batch = await db().client.couponBatch.findUniqueOrThrow({ where: { id: batchId } });
    assert.equal(batch.totalCount, 3, 'the cap must not be rewritten to hide a breach');
    assert.equal(await db().client.coupon.count({ where: { batchId } }), 3);
  });

  it('deactivates coupon batch and banner', async () => {
    const authHeader = await loginAdmin();
    const now = new Date();
    const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const promoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promotions',
      headers: authHeader,
      payload: {
        title: 'Batch promo',
        discountType: 'PERCENT',
        discountValue: 10,
        // FR-020. A percentage promotion now requires a ceiling: an uncapped one
        // is open-ended on a long trip, and a typo in `discountValue` had nothing
        // between it and a free ride.
        maxDiscount: 40,
        validFrom: now.toISOString(),
        validTo: later.toISOString(),
      },
    });
    assert.equal(promoRes.statusCode, 201, promoRes.payload);

    const batchRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/coupon-batches',
      headers: authHeader,
      payload: {
        promotionId: promoRes.json().data.id,
        name: 'Toggle batch',
        prefix: 'TG',
        totalCount: 3,
        perUserLimit: 1,
        generateNow: true,
      },
    });
    assert.equal(batchRes.statusCode, 201, batchRes.payload);
    const batchId = batchRes.json().data.id;

    const batchOff = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/coupon-batches/${batchId}/deactivate`,
      headers: authHeader,
    });
    assert.equal(batchOff.statusCode, 200, batchOff.payload);
    assert.equal(batchOff.json().data.isActive, false);

    const batchOn = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/coupon-batches/${batchId}/activate`,
      headers: authHeader,
    });
    assert.equal(batchOn.statusCode, 200, batchOn.payload);
    assert.equal(batchOn.json().data.isActive, true);

    const bannerFileId = await seedPromoBannerFile(authHeader.adminUserId);
    const bannerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/promo-banners',
      headers: authHeader,
      payload: {
        title: 'Toggle banner',
        imageFileId: bannerFileId,
        placement: 'OFFERS',
        priority: 5,
      },
    });
    assert.equal(bannerRes.statusCode, 201, bannerRes.payload);
    const bannerId = bannerRes.json().data.id;

    const bannerOff = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/promo-banners/${bannerId}/deactivate`,
      headers: authHeader,
    });
    assert.equal(bannerOff.statusCode, 200, bannerOff.payload);
    assert.equal(bannerOff.json().data.isActive, false);
  });
});
