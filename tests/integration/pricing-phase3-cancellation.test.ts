import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { ensureCityWithBoundary, ensureServiceZone, grantRole } from './helpers/fixtures.js';
import { acceptRide, rideWorld } from './helpers/ride-flow.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { CANCELLATION_POLICY_ENFORCEMENT_FLAG } from '../../src/modules/pricing/constants.js';

const ADMIN_PHONE = '+919876639001';
const ADMIN_EMAIL = 'phase3-cancel-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const CUSTOMER_PHONE = '+919876639002';
const DRIVER_PHONE = '+919876639003';

const SGR_BOUNDS: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

describe('Phase 3 — Cancellation Policy Versioning, Resolution & Quotes (integration)', () => {
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
    return { authorization: `Bearer ${res.json().accessToken}` };
  }

  async function setEnforcementFlag(status: 'ON' | 'OFF') {
    await db().client.featureFlag.upsert({
      where: { key: CANCELLATION_POLICY_ENFORCEMENT_FLAG },
      update: { status, isActive: true, rolloutPercentage: 100 },
      create: {
        key: CANCELLATION_POLICY_ENFORCEMENT_FLAG,
        name: 'Enforce cancellation policies',
        description: 'Phase 3 test flag',
        status,
        isActive: true,
        rolloutPercentage: 100,
      },
    });
  }

  it('3.1 versions policies on edit, enforces expectedVersion 409, lists history, and blocks future overlaps', async () => {
    const headers = await loginAdmin();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers,
      payload: {
        ruleName: 'Rider Late Cancel',
        actor: 'rider',
        scenario: 'after_arrival',
        chargeType: 'percentage',
        chargeAmount: 15,
        feeBase: 'QUOTED_FARE',
        maxFee: 60,
        freeCancelWindowSec: 120,
        driverCompensationType: 'PERCENT_OF_FEE',
        driverCompensationAmount: 75,
        status: 'active',
      },
    });
    assert.equal(createRes.statusCode, 201, createRes.payload);
    const v1 = createRes.json().data;
    assert.equal(v1.version, 1);
    assert.equal(v1.maxFee, 60);
    assert.equal(v1.driverCompensationType, 'PERCENT_OF_FEE');
    assert.equal(v1.driverCompensationAmount, 75);

    // Stale expectedVersion returns 409 CANCELLATION_POLICY_STALE
    const staleRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/cancellation-policies/${v1.id}`,
      headers,
      payload: { chargeAmount: 20, expectedVersion: 99 },
    });
    assert.equal(staleRes.statusCode, 409, staleRes.payload);
    assert.equal(staleRes.json().error.code, 'CANCELLATION_POLICY_STALE');

    // Substantive edit creates v2 in the same family and retires v1
    const v2Res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/cancellation-policies/${v1.id}`,
      headers,
      payload: { chargeAmount: 20, maxFee: 80, expectedVersion: 1 },
    });
    assert.equal(v2Res.statusCode, 200, v2Res.payload);
    const v2 = v2Res.json().data;
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.familyId, v1.familyId);
    assert.equal(v2.version, 2);
    assert.equal(v2.supersedesId, v1.id);
    assert.equal(v2.chargeAmount, 20);
    assert.equal(v2.maxFee, 80);

    const v1After = await db().client.cancellationPolicy.findUniqueOrThrow({ where: { id: v1.id } });
    assert.equal(v1After.isActive, false);

    // Version history returns [v2, v1]
    const versionsRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/cancellation-policies/${v2.id}/versions`,
      headers,
    });
    assert.equal(versionsRes.statusCode, 200, versionsRes.payload);
    const versions = versionsRes.json().data as Array<{ id: string; version: number }>;
    assert.deepEqual(
      versions.map((r) => [r.id, r.version]),
      [
        [v2.id, 2],
        [v1.id, 1],
      ],
    );

    // Scheduled future policy + conflicting earlier-starting policy -> 409 CANCELLATION_POLICY_CONFLICT
    const futureStart = new Date(Date.now() + 3_600_000).toISOString();
    const schedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers,
      payload: {
        actor: 'rider',
        scenario: 'after_arrival',
        chargeType: 'fixed',
        chargeAmount: 45,
        effectiveFrom: futureStart,
        status: 'active',
      },
    });
    assert.equal(schedRes.statusCode, 201, schedRes.payload);

    // Live v2 had its effectiveTo closed cleanly at futureStart without deactivating it!
    const v2Closed = await db().client.cancellationPolicy.findUniqueOrThrow({ where: { id: v2.id } });
    assert.equal(v2Closed.isActive, true);
    assert.equal(v2Closed.effectiveTo?.toISOString(), futureStart);

    // Trying to create an overlapping open-ended rule starting BEFORE futureStart conflicts with scheduled rule
    const conflictRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers,
      payload: {
        actor: 'rider',
        scenario: 'after_arrival',
        chargeType: 'fixed',
        chargeAmount: 55,
        effectiveFrom: new Date(Date.now() + 1_800_000).toISOString(),
        status: 'active',
      },
    });
    assert.equal(conflictRes.statusCode, 409, conflictRes.payload);
    assert.equal(conflictRes.json().error.code, 'CANCELLATION_POLICY_CONFLICT');
  });

  it('3.2 admin evaluate endpoint resolves 4-level cascade, percentage caps, and driver compensation', async () => {
    const headers = await loginAdmin();
    const vehicleType = await db().client.vehicleType.findFirstOrThrow();

    // Global baseline: flat ₹20
    const g = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers,
      payload: {
        actor: 'rider',
        scenario: 'after_assignment',
        chargeType: 'fixed',
        chargeAmount: 20,
        freeCancelWindowSec: 60,
      },
    });
    assert.equal(g.statusCode, 201, g.payload);

    // City + Vehicle override: 10% capped at ₹45, 50% driver compensation
    const cv = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers,
      payload: {
        actor: 'rider',
        scenario: 'after_assignment',
        cityCode: 'SGR',
        vehicleTypeId: vehicleType.id,
        chargeType: 'percentage',
        chargeAmount: 10,
        maxFee: 45,
        freeCancelWindowSec: 90,
        driverCompensationType: 'PERCENT_OF_FEE',
        driverCompensationAmount: 50,
      },
    });
    assert.equal(cv.statusCode, 201, cv.payload);
    const cvId = cv.json().data.id as string;

    // Evaluate SGR + vehicleType after grace -> wins priority 4, capped to ₹45, driver comp ₹22.50
    const evalCityVeh = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies/evaluate',
      headers,
      payload: {
        actor: 'rider',
        scenario: 'after_assignment',
        cityCode: 'SGR',
        vehicleTypeId: vehicleType.id,
        elapsedSec: 120,
        quotedFare: 600,
      },
    });
    assert.equal(evalCityVeh.statusCode, 200, evalCityVeh.payload);
    const r1 = evalCityVeh.json().data;
    assert.equal(r1.enforcementEnabled, false); // Default OFF
    assert.equal(r1.matchedPolicy.id, cvId);
    assert.equal(r1.matchedPolicy.scopePriority, 4);
    assert.equal(r1.rawFee, 60);
    assert.equal(r1.cancellationFee, 45);
    assert.equal(r1.driverCompensation, 22.5);
    assert.equal(r1.feeStatus, 'ASSESSED');

    // Evaluate another city -> falls back cleanly to global ₹20
    const evalGlobal = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies/evaluate',
      headers,
      payload: {
        actor: 'rider',
        scenario: 'after_assignment',
        cityCode: 'DEL',
        vehicleTypeId: vehicleType.id,
        elapsedSec: 120,
        quotedFare: 600,
      },
    });
    assert.equal(evalGlobal.statusCode, 200, evalGlobal.payload);
    assert.equal(evalGlobal.json().data.cancellationFee, 20);
    assert.equal(evalGlobal.json().data.matchedPolicy.scopePriority, 1);
  });

  it('3.3 & 3.4 enforces active policy when flag is ON, matches cancellation-quote, and protects write-once policy_snapshot', async () => {
    const headers = await loginAdmin();
    const w = await rideWorld(app, { customer: CUSTOMER_PHONE, driver: DRIVER_PHONE });
    await ensureCityWithBoundary('SGR', 'Srinagar', SGR_BOUNDS);
    await ensureServiceZone('SGR', 'SGR_CITY', 'Srinagar City', SGR_BOUNDS);

    // Create active city+vehicle policy: 0s grace, flat ₹35, driver compensation ₹25
    const polRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/cancellation-policies',
      headers,
      payload: {
        ruleName: 'SGR After Assignment Fee',
        actor: 'rider',
        scenario: 'after_assignment',
        cityCode: 'SGR',
        vehicleTypeId: w.vehicleTypeId,
        chargeType: 'fixed',
        chargeAmount: 35,
        freeCancelWindowSec: 0,
        driverCompensationType: 'FLAT',
        driverCompensationAmount: 25,
      },
    });
    assert.equal(polRes.statusCode, 201, polRes.payload);
    const policy = polRes.json().data;

    // Book & accept ride in SGR
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: w.customer.authHeader,
      payload: {
        vehicleTypeId: w.vehicleTypeId,
        pickupLat: 34.0837,
        pickupLng: 74.7973,
        dropLat: 34.12,
        dropLng: 74.83,
        paymentMethod: 'CASH',
      },
    });
    assert.equal(reqRes.statusCode, 200, reqRes.payload);
    const requestId = reqRes.json().data.id as string;
    const rideId = await acceptRide(app, w, requestId);

    // 1) With flag OFF (default), cancellation-quote reports enforcementEnabled=false and legacy ₹0 (ACCEPTED within grace)
    const quoteOff = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/cancellation-quote`,
      headers: w.customer.authHeader,
    });
    assert.equal(quoteOff.statusCode, 200, quoteOff.payload);
    assert.equal(quoteOff.json().data.enforcementEnabled, false);
    assert.equal(quoteOff.json().data.estimatedFee, 0);
    assert.equal(quoteOff.json().data.driverCompensationPreview, undefined); // stripped for customer

    // 2) Flip enforcement flag ON -> customer quote predicts exact ₹35 from active DB policy
    await setEnforcementFlag('ON');

    const quoteOn = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/cancellation-quote`,
      headers: w.customer.authHeader,
    });
    assert.equal(quoteOn.statusCode, 200, quoteOn.payload);
    const qData = quoteOn.json().data;
    assert.equal(qData.enforcementEnabled, true);
    assert.equal(qData.policyId, policy.id);
    assert.equal(qData.policyVersion, 1);
    assert.equal(qData.estimatedFee, 35);
    assert.equal(qData.feeStatusPreview, 'ASSESSED');
    assert.equal(qData.driverCompensationPreview, undefined); // stripped for customer

    // 3) Customer cancels -> ride_cancellations persists exact assessed fee, driverComp, policyId/version & immutable snapshot
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: w.customer.authHeader,
      payload: { reasonCode: 'CHANGED_MIND' },
    });
    assert.equal(cancelRes.statusCode, 200, cancelRes.payload);

    const row = await db().client.rideCancellation.findUniqueOrThrow({ where: { rideId } });
    assert.equal(Number(row.cancellationFee), 35);
    assert.equal(Number(row.driverCompensation), 25);
    assert.equal(row.feeCharged, false); // Assessed only, never auto-collected!
    assert.equal(row.feeStatus, 'ASSESSED');
    assert.equal(row.policyId, policy.id);
    assert.equal(row.policyVersion, 1);
    assert.ok(row.policySnapshot && typeof row.policySnapshot === 'object');
    assert.equal(
      (row.policySnapshot as Record<string, unknown>).enforcementMode,
      'POLICY_ENGINE',
    );

    // 4) DB write-once trigger rejects any mutation to ride_cancellations.policy_snapshot
    await assert.rejects(
      async () => {
        await db().client.$executeRawUnsafe(
          `UPDATE ride_cancellations SET policy_snapshot = '{"tampered":true}'::jsonb WHERE id = $1::uuid`,
          row.id,
        );
      },
      /write-once and immutable/i,
    );

    // 5) Calling cancellation-quote on an already-cancelled ride returns 409
    const afterCancelQuote = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/${rideId}/cancellation-quote`,
      headers: w.customer.authHeader,
    });
    assert.equal(afterCancelQuote.statusCode, 409, afterCancelQuote.payload);
  });
});
