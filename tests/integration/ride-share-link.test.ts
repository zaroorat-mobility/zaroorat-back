import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { rateLimits } from '../../src/config/rate-limit/rate-limit.config.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { acceptRide, bookRideRequest, rideWorld, type RideWorld } from './helpers/ride-flow.js';

/// GET /api/v1/rides/share/:token — the public trip-tracking link a rider sends
/// to family. The link is the only credential, so what it reveals, for how long,
/// and how hard it can be hit are the whole security story.
describe('ride share link (integration, public route)', () => {
  let app: FastifyInstance;
  let world: RideWorld;
  let rideId: string;
  let token: string;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState();
    world = await rideWorld(app, { customer: '+919876781001', driver: '+919876781002' });
    rideId = await acceptRide(app, world, await bookRideRequest(app, world, { distanceKm: 5 }));
    const shared = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/share`,
      headers: world.customer.authHeader,
    });
    assert.equal(shared.statusCode, 200, shared.payload);
    token = shared.json().data.token;
  });

  function view(t = token) {
    // No Authorization header: the route is public by design.
    return app.inject({ method: 'GET', url: `/api/v1/rides/share/${t}` });
  }

  async function setStatus(status: string) {
    await db().client.$executeRaw`
      UPDATE rides SET status = ${status}::"RideStatus" WHERE id = ${rideId}::uuid`;
  }

  it('issues a 192-bit link that expires after the configured 12 hours', async () => {
    assert.equal(Buffer.from(token, 'base64url').length, 24);
    const row = await db().client.rideShareToken.findUniqueOrThrow({ where: { token } });
    const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
    assert.ok(Math.abs(hours - 12) < 0.01, `expiry ${hours}h`);
  });

  it('shows the trip while it is live, with no phone numbers or rider identity', async () => {
    const res = await view();
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.headers['cache-control'], 'no-store');
    const data = res.json().data;
    assert.equal(data.isLive, true);
    assert.equal(data.pickup.latitude, 12.9716);
    assert.ok(data.drop, 'drop shown while live');
    assert.doesNotMatch(res.payload, /phone|\+91/i, 'no phone numbers in the payload');
    assert.equal('customer' in data, false);
  });

  for (const ended of ['COMPLETED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_DRIVER']) {
    it(`hides pickup and drop once the ride is ${ended}, though the link has not expired`, async () => {
      await setStatus(ended);
      const res = await view();
      assert.equal(res.statusCode, 200, res.payload);
      const data = res.json().data;
      assert.equal(data.status, ended);
      assert.equal(data.isLive, false);
      assert.equal(data.pickup, null);
      assert.equal(data.drop, null);
      assert.equal(data.driverLocation, null);
      assert.doesNotMatch(res.payload, /12\.97|77\.59/, 'no pickup/drop coordinates anywhere');
    });
  }

  it('refuses an expired link the same way as an unknown one', async () => {
    await db().client.rideShareToken.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await view();
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'SHARE_LINK_NOT_FOUND');
  });

  it('refuses a revoked link', async () => {
    await db().client.rideShareToken.update({ where: { token }, data: { revokedAt: new Date() } });
    assert.equal((await view()).statusCode, 404);
  });

  it('refuses invalid tokens without saying why', async () => {
    const forged = Buffer.alloc(24, 7).toString('base64url');
    const oneCharOff = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const bad of [forged, 'short', oneCharOff]) {
      const res = await view(bad);
      assert.equal(res.statusCode, 404, bad);
      assert.equal(res.json().error.code, 'SHARE_LINK_NOT_FOUND');
    }
  });

  it('rate-limits one IP hammering the link', async () => {
    const { limit } = rateLimits.rideShareView;
    for (let i = 0; i < limit; i++) {
      const res = await view();
      assert.equal(res.statusCode, 200, `request ${i + 1}: ${res.payload}`);
    }
    const blocked = await view();
    assert.equal(blocked.statusCode, 429);
    // Unknown tokens draw from the same budget, so the limit also caps sweeping.
    assert.equal((await view(Buffer.alloc(24, 9).toString('base64url'))).statusCode, 429);
  });
});
