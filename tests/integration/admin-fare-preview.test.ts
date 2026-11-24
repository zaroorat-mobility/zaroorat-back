import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import { pricingConfig } from '../../src/config/pricing/pricing.config.js';
import type { PricingService } from '../../src/modules/pricing/services/pricing.service.js';

const ADMIN_PHONE = '+919876545101';
const ADMIN_EMAIL = 'preview-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

/// The admin fare preview must be the server's own price, not a second formula. Each case
/// saves a real rule, then asks PricingService to price the same trip on that stored rule,
/// and requires the preview to match it exactly.
describe('admin fare rule preview (integration)', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
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
    headers = { authorization: `Bearer ${loggedIn.json().accessToken as string}` };
  });
  afterEach(async () => {
    await resetState();
  });

  const pricing = () => container.resolve<PricingService>('pricingService');

  const RULE = {
    baseFare: 40,
    minimumFare: 120,
    perKmRate: 11,
    perMinuteRate: 1.5,
    freeWaitingMinutes: 3,
    waitingChargePerMinute: 2,
    bookingFee: 10,
    platformFeePct: 0,
  };

  async function saveRule(rates: { taxRatePct?: number; commissionRatePct?: number }) {
    const car = await db().client.vehicleType.findFirstOrThrow({
      where: { category: 'car', isActive: true },
    });
    // resetState seeds an open-ended GLOBAL rate card per type, and a second
    // active overlapping rule is refused (FARE_RULE_CONFLICT), so retire it first.
    await db().client.pricingRule.updateMany({
      where: { vehicleTypeId: car.id, cityCode: 'GLOBAL' },
      data: { isActive: false },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules',
      headers,
      payload: {
        ...RULE,
        ...rates,
        vehicleTypeId: car.id,
        cityCode: 'GLOBAL',
        effectiveFrom: `${new Date().getFullYear() - 1}-01-01`,
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    return { ruleId: created.json().data.id as string, vehicleTypeId: car.id };
  }

  async function preview(body: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules/preview',
      headers,
      payload: body,
    });
    assert.equal(res.statusCode, 200, res.payload);
    return res.json().data as {
      fare: Record<string, number>;
      commissionAtAcceptance: number;
      rates: {
        taxRatePct: number;
        taxRateIsDefault: boolean;
        commissionRatePct: number;
        commissionRateIsDefault: boolean;
      };
    };
  }

  const trips = [
    { name: 'short trip on the minimum fare', distanceKm: 1, durationMin: 4 },
    { name: 'waiting beyond the free minutes', distanceKm: 6, durationMin: 18, waitingMinutes: 9 },
    { name: 'surge', distanceKm: 8, durationMin: 25, surgeMultiplier: 1.6 },
    { name: 'promo discount', distanceKm: 8, durationMin: 25, discountAmount: 40 },
    {
      name: 'discount larger than the margin (negative residual)',
      distanceKm: 3,
      durationMin: 10,
      discountAmount: 115,
    },
    { name: 'fare ceiling', distanceKm: 20, durationMin: 70, fareCeiling: 300 },
  ];

  for (const rates of [{}, { commissionRatePct: 12.5, taxRatePct: 0 }]) {
    const label = Object.keys(rates).length ? 'explicit rates' : 'platform-default rates';
    for (const trip of trips) {
      it(`matches PricingService for ${trip.name} (${label})`, async () => {
        const { ruleId, vehicleTypeId } = await saveRule(rates);
        const got = await preview({ ...RULE, ...rates, ...trip });

        const expected = await pricing().calculateFinalFare({
          actualDistanceKm: trip.distanceKm,
          actualDurationMin: trip.durationMin,
          vehicleTypeId,
          pricingRuleId: ruleId,
          ...('waitingMinutes' in trip ? { waitingMinutes: trip.waitingMinutes } : {}),
          ...('surgeMultiplier' in trip ? { surgeMultiplier: trip.surgeMultiplier } : {}),
          ...('discountAmount' in trip ? { discountAmount: trip.discountAmount } : {}),
          ...('fareCeiling' in trip ? { fareCeiling: trip.fareCeiling } : {}),
        });
        assert.deepEqual(got.fare, expected);

        const locked = await pricing().estimatedCommission({
          estimatedDistanceKm: trip.distanceKm,
          estimatedDurationMin: trip.durationMin,
          vehicleTypeId,
          pricingRuleId: ruleId,
        });
        assert.equal(got.commissionAtAcceptance, locked);
        // The components a driver and the platform split always add back to what the rider pays.
        assert.equal(
          Number(
            (
              got.fare.driverEarning! +
              got.fare.platformCommission! +
              got.fare.taxAmount! +
              got.fare.platformFee!
            ).toFixed(2),
          ),
          got.fare.totalFare,
        );
      });
    }
  }

  it('reports the platform default when a rate is left blank, and the rule value when set', async () => {
    const inherited = await preview({ ...RULE, distanceKm: 5, durationMin: 15 });
    assert.equal(inherited.rates.commissionRateIsDefault, true);
    assert.equal(
      inherited.rates.commissionRatePct,
      pricingConfig.defaultRateCard.commissionRatePct,
    );
    assert.equal(inherited.rates.taxRateIsDefault, true);
    assert.equal(inherited.rates.taxRatePct, pricingConfig.defaultRateCard.taxRatePct);

    const explicit = await preview({
      ...RULE,
      commissionRatePct: 7,
      taxRatePct: 0,
      distanceKm: 5,
      durationMin: 15,
    });
    assert.equal(explicit.rates.commissionRateIsDefault, false);
    assert.equal(explicit.rates.commissionRatePct, 7);
    assert.equal(explicit.fare.taxAmount, 0);
  });

  it('serves the platform defaults, and refuses both routes without pricing:read', async () => {
    const defaults = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules/platform-defaults',
      headers,
    });
    assert.equal(defaults.statusCode, 200, defaults.payload);
    assert.equal(
      defaults.json().data.commissionRatePct,
      pricingConfig.defaultRateCard.commissionRatePct,
    );

    const rider = await loginAs(app, '+919876545102');
    const asRider = { authorization: rider.authHeader.authorization };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules/preview',
      headers: asRider,
      payload: { ...RULE, distanceKm: 5, durationMin: 15 },
    });
    assert.equal(denied.statusCode, 403, denied.payload);
    const deniedDefaults = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/fare-rules/platform-defaults',
      headers: asRider,
    });
    assert.equal(deniedDefaults.statusCode, 403, deniedDefaults.payload);
  });

  it('rejects an invalid trip instead of pricing it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fare-rules/preview',
      headers,
      payload: { ...RULE, distanceKm: -1, durationMin: 15 },
    });
    assert.equal(res.statusCode, 400, res.payload);
  });
});
