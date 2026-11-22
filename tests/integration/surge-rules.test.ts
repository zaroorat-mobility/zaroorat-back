import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  completeProfile,
  createPricingRuleDirect,
  ensureCityWithBoundary,
  ensureServiceZone,
  setRidePin,
} from './helpers/fixtures.js';

const CITY: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];
const ZONE: number[][][] = [
  [
    [74.72, 34.02],
    [74.76, 34.02],
    [74.76, 34.06],
    [74.72, 34.06],
    [74.72, 34.02],
  ],
];
const PICKUP = { pickupLat: 34.04, pickupLng: 74.74 };
const OUTSIDE_ZONE = { pickupLat: 34.15, pickupLng: 74.9 };
const DROP = { dropLat: 34.1, dropLng: 74.85 };
const HOUR = 3_600_000;

/// What a rider is really charged, through the real API: quote and booking.
describe('surge on quotes and bookings (integration)', () => {
  let app: FastifyInstance;
  let rider: LoggedInUser;
  let vehicleTypeId: string;
  let zoneId: string;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
    await ensureCityWithBoundary('SGR', 'Srinagar', CITY);
    zoneId = await ensureServiceZone('SGR', 'SGR_SZ', 'Zone', ZONE);
    vehicleTypeId = (
      await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY_NON_AC' } })
    ).id;
    await createPricingRuleDirect({ vehicleTypeId, cityCode: 'SGR', baseFare: 100 });
    rider = await loginAs(app, '+919876720055');
    await completeProfile(rider.userId);
    await setRidePin(rider.userId);
  });
  afterEach(async () => {
    await db().client.featureFlag.updateMany({ where: { key: 'surge' }, data: { status: 'ON' } });
    await resetState();
  });

  async function quotedSurge(pickup: typeof PICKUP = PICKUP): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/quote',
      headers: rider.authHeader,
      payload: { ...pickup, ...DROP, vehicleTypeId },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data as {
      options?: Array<{ vehicleTypeId: string; fareBreakdown: { surgeMultiplier: number } }>;
      fareBreakdown?: { surgeMultiplier: number };
    };
    const option = body.options?.find((o) => o.vehicleTypeId === vehicleTypeId) ?? body;
    return Number(option.fareBreakdown?.surgeMultiplier);
  }

  async function bookedSurge(): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: { ...rider.authHeader, 'idempotency-key': randomUUID() },
      payload: { vehicleTypeId, ...PICKUP, ...DROP },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const row = await db().client.rideRequest.findUniqueOrThrow({
      where: { id: res.json().data.id as string },
    });
    return Number(row.surgeMultiplier);
  }

  const zoneWindow = (data: Record<string, unknown> = {}) =>
    db().client.surgeWindow.create({
      data: {
        serviceZoneId: zoneId,
        multiplier: 1.5,
        startsAt: new Date(Date.now() - HOUR),
        ...data,
      } as never,
    });

  it('charges the rule in force', async () => {
    await zoneWindow();
    assert.equal(await quotedSurge(), 1.5);
    assert.equal(await bookedSurge(), 1.5);
  });

  it('limits both quote and booking to the city cap', async () => {
    await db().client.city.update({ where: { code: 'SGR' }, data: { maxSurgeMultiplier: 1.5 } });
    await zoneWindow({ multiplier: 2 });
    assert.equal(await quotedSurge(), 1.5);
    assert.equal(await bookedSurge(), 1.5);
  });

  it('charges a whole-city rule outside every zone', async () => {
    await db().client.surgeWindow.create({
      data: { cityCode: 'SGR', multiplier: 1.3, startsAt: new Date(Date.now() - HOUR) },
    });
    assert.equal(await quotedSurge(OUTSIDE_ZONE), 1.3);
  });

  it('takes the higher of a whole-city rule and a zone rule', async () => {
    await db().client.surgeWindow.create({
      data: { cityCode: 'SGR', multiplier: 1.3, startsAt: new Date(Date.now() - HOUR) },
    });
    await zoneWindow({ multiplier: 1.7 });
    assert.equal(await quotedSurge(), 1.7);
  });

  it('ignores a whole-city rule from another city', async () => {
    await db().client.surgeWindow.create({
      data: { cityCode: 'PNQ', multiplier: 1.9, startsAt: new Date(Date.now() - HOUR) },
    });
    assert.equal(await quotedSurge(), 1);
  });

  it('charges no surge on quote or booking when the off-switch is on', async () => {
    await zoneWindow();
    await db().client.featureFlag.upsert({
      where: { key: 'surge' },
      update: { status: 'OFF' },
      create: { key: 'surge', name: 'surge', status: 'OFF', rolloutPercentage: 100, isActive: true },
    });
    assert.equal(await quotedSurge(), 1);
    assert.equal(await bookedSurge(), 1);
  });

  it('skips a rule limited to another day', async () => {
    const today = new Date(Date.now() + 5.5 * HOUR).getUTCDay();
    await zoneWindow({ daysOfWeek: [(today + 1) % 7] });
    assert.equal(await quotedSurge(), 1);
  });

  it('keeps the booked fare when the rule changes after booking', async () => {
    const window = await zoneWindow();
    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: { ...rider.authHeader, 'idempotency-key': randomUUID() },
      payload: { vehicleTypeId, ...PICKUP, ...DROP },
    });
    assert.equal(booked.statusCode, 200, booked.payload);
    const id = booked.json().data.id as string;

    await db().client.surgeWindow.update({ where: { id: window.id }, data: { multiplier: 2 } });

    const row = await db().client.rideRequest.findUniqueOrThrow({ where: { id } });
    assert.equal(Number(row.surgeMultiplier), 1.5);
  });
});
