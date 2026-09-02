import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { makeDriver, makeRide, makeRideRequest, makeVehicle } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { PromotionService } from '../../src/modules/promotions/promotion.service.js';
import { TransactionManager } from '../../src/core/database/TransactionManager.js';

const DAY = 24 * 60 * 60 * 1000;

/// FR-017 / FR-018 / FR-019 / FR-020 / FR-021 / FR-043.
///
/// Every cap in this module used to be check-then-act: eligibility read the
/// counts at booking, `redeem` wrote unconditionally inside the completion
/// transaction minutes later, and nothing in the database backed either. The
/// races below are the ones that were actually reachable, and each asserts the
/// invariant — the cap held — rather than which caller won (constitution 14.2).
describe('promotion usage limits (integration)', () => {
  let app: FastifyInstance;
  let promotions: PromotionService;
  let txManager: TransactionManager;
  let driverId: string;
  let vehicleId: string;
  let userIds: string[];

  before(async () => {
    app = await bootApp();
    promotions = container.resolve<PromotionService>('promotionService');
    txManager = container.resolve<TransactionManager>('transactionManager');
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    userIds = [];
    for (let i = 0; i < 6; i++) {
      const user = await db().client.user.create({
        data: { phoneNumber: `+9198765500${10 + i}` },
      });
      userIds.push(user.id);
    }
    const driverUser = await db().client.user.create({ data: { phoneNumber: '+919876550099' } });
    driverId = await makeDriver(driverUser.id);
    const vehicleType = await db().client.vehicleType.findFirstOrThrow();
    vehicleId = await makeVehicle(vehicleType.id);
  });
  afterEach(async () => {
    await resetState();
  });

  /// `redeem` writes a `RidePromoApplied` row too, whose `rideId` is a required
  /// FK — so a race over redemption needs one real ride per attempt, not a null.
  /// A completed ride, built through the shared fixtures. `redeem` writes a
  /// `RidePromoApplied` row whose `rideId` is a required FK, so each attempt in a
  /// race needs a real ride — and neither `rides` nor `ride_requests` can be
  /// created through Prisma at all, because both carry NOT NULL PostGIS columns
  /// that Prisma models as `Unsupported`.
  async function completedRideFor(customerId: string): Promise<string> {
    const vehicleType = await db().client.vehicleType.findFirstOrThrow();
    const requestId = await makeRideRequest(customerId, vehicleType.id);
    // `ride_requests_active_customer_key` allows one CREATED/SEARCHING request
    // per customer, and these races give one rider several completed rides. The
    // fixture leaves the request SEARCHING, so move it on once its ride exists —
    // which is what the real matching flow does anyway.
    await db().client.rideRequest.update({
      where: { id: requestId },
      data: { status: 'MATCHED' },
    });
    return makeRide({
      requestId,
      customerId,
      driverId,
      vehicleId,
      vehicleTypeId: vehicleType.id,
      status: 'COMPLETED',
    });
  }

  async function makePromotion(overrides: {
    code?: string;
    usageLimitTotal?: number | null;
    usageLimitPerUser?: number | null;
    usedCount?: number;
  }): Promise<string> {
    const row = await db().client.promotion.create({
      data: {
        code: overrides.code ?? 'SAVE20',
        discountType: 'FIXED',
        discountValue: 20,
        minFare: 0,
        usageLimitTotal: overrides.usageLimitTotal ?? null,
        usageLimitPerUser:
          overrides.usageLimitPerUser === undefined ? 1 : overrides.usageLimitPerUser,
        usedCount: overrides.usedCount ?? 0,
        validFrom: new Date(Date.now() - DAY),
        validTo: new Date(Date.now() + DAY),
        isActive: true,
      },
    });
    return row.id;
  }

  /// Redemption happens inside the ride-completion transaction, so the race has
  /// to be run the same way — one transaction per attempt, all in flight at once.
  async function redeemConcurrently(
    promotionId: string,
    riders: string[],
  ): Promise<{ ok: number; refused: number }> {
    const attempts: Array<{ userId: string; rideId: string }> = [];
    for (const userId of riders) {
      attempts.push({ userId, rideId: await completedRideFor(userId) });
    }
    const results = await Promise.allSettled(
      attempts.map((attempt, i) =>
        txManager.execute(async (tx) => {
          await promotions.redeem({
            promo: {
              promotionId,
              code: 'SAVE20',
              title: null,
              discountType: 'FIXED',
              discountValue: 20,
              maxDiscount: null,
              minFare: 0,
              couponId: null,
              discountAmount: 20,
            },
            userId: attempt.userId,
            rideId: attempt.rideId,
            client: tx,
          });
          return i;
        }),
      ),
    );
    return {
      ok: results.filter((r) => r.status === 'fulfilled').length,
      refused: results.filter((r) => r.status === 'rejected').length,
    };
  }

  it('R1: never exceeds the total limit under concurrent completions (FR-017)', async () => {
    // One slot left, six riders finishing at once.
    const promotionId = await makePromotion({ usageLimitTotal: 5, usedCount: 4 });
    const { ok, refused } = await redeemConcurrently(promotionId, userIds);

    assert.equal(ok, 1, 'exactly one completion may take the last slot');
    assert.equal(refused, 5);

    const promo = await db().client.promotion.findUniqueOrThrow({ where: { id: promotionId } });
    assert.equal(promo.usedCount, 5, 'usedCount must never pass usageLimitTotal');
    assert.equal(
      await db().client.promotionRedemption.count({ where: { promotionId } }),
      1,
      'and exactly one redemption row may exist',
    );
  });

  it('R2: never exceeds the per-user limit for one rider (FR-017)', async () => {
    // One rider, four rides completing at once, promotion is once-per-user.
    const promotionId = await makePromotion({ usageLimitTotal: null, usageLimitPerUser: 1 });
    const rider = userIds[0]!;
    const { ok } = await redeemConcurrently(promotionId, [rider, rider, rider, rider]);

    assert.equal(ok, 1, 'a once-per-user promotion must be redeemed once');
    assert.equal(
      await db().client.promotionRedemption.count({ where: { promotionId, userId: rider } }),
      1,
    );
  });

  it('honours a per-user limit above one, and stops at it (FR-017)', async () => {
    const promotionId = await makePromotion({ usageLimitTotal: null, usageLimitPerUser: 2 });
    const rider = userIds[0]!;
    const { ok } = await redeemConcurrently(promotionId, [rider, rider, rider, rider, rider]);

    assert.equal(ok, 2, 'a limit of two means two, whatever the concurrency');
    assert.equal(
      await db().client.promotionRedemption.count({ where: { promotionId, userId: rider } }),
      2,
    );
  });

  it('treats a null per-user limit as unlimited (FR-043)', async () => {
    const promotionId = await makePromotion({ usageLimitTotal: null, usageLimitPerUser: null });
    const rider = userIds[0]!;
    const { ok } = await redeemConcurrently(promotionId, [rider, rider, rider]);
    assert.equal(ok, 3, 'null is unlimited, matching usageLimitTotal');
  });

  it('refuses a promotion restricted to a vehicle type when none is supplied (FR-018)', async () => {
    const vehicleType = await db().client.vehicleType.findUniqueOrThrow({
      where: { code: 'BIKE' },
    });
    await db().client.promotion.create({
      data: {
        code: 'BIKEONLY',
        discountType: 'FIXED',
        discountValue: 20,
        minFare: 0,
        applicableVehicleType: vehicleType.id,
        usageLimitPerUser: 1,
        validFrom: new Date(Date.now() - DAY),
        validTo: new Date(Date.now() + DAY),
        isActive: true,
      },
    });

    // The city branch already refused on a missing city; this one used to pass.
    await assert.rejects(
      () => promotions.validateAndResolve('BIKEONLY', { userId: userIds[0]!, subtotal: 200 }),
      /not valid for this vehicle type/i,
      'an unevaluable restriction must deny, not admit',
    );

    // And still resolves when the context does name the right type.
    const resolved = await promotions.validateAndResolve('BIKEONLY', {
      userId: userIds[0]!,
      vehicleTypeId: vehicleType.id,
      subtotal: 200,
    });
    assert.equal(resolved.discountAmount, 20);
  });

  it('evaluates a segment rule the admin schema accepts (FR-021)', async () => {
    const promotionId = await makePromotion({ code: 'FIRSTONLY' });
    const segment = await db().client.audienceSegment.create({
      data: { code: 'SEG_FIRST', name: 'First ride riders', rules: { firstRideOnly: true } },
    });
    const campaign = await db().client.promoCampaign.create({
      data: { code: 'CMP1', name: 'Acquisition' },
    });
    await db().client.campaignTarget.create({
      data: { campaignId: campaign.id, segmentId: segment.id, promotionId },
    });

    // A rider with no completed ride matches the segment.
    const fresh = userIds[0]!;
    const resolved = await promotions.validateAndResolve('FIRSTONLY', {
      userId: fresh,
      subtotal: 200,
    });
    assert.equal(resolved.discountAmount, 20);

    // A rider who has completed one does not. `firstRideOnly` was accepted by
    // `createSegmentBodySchema` and evaluated by nothing, so this rider used to
    // match a segment explicitly defined to exclude them.
    const veteran = userIds[1]!;
    await completedRideFor(veteran);

    await assert.rejects(
      () => promotions.validateAndResolve('FIRSTONLY', { userId: veteran, subtotal: 200 }),
      /campaign audience/i,
      'a segment rule the admin can set must actually be enforced',
    );
  });
});
