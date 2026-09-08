import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { makeDispatchOffer, setRidePin, RIDE_PIN } from './helpers/fixtures.js';
import { rideWorld, type RideWorld } from './helpers/ride-flow.js';

/// The guarantees the Ride PIN exists to provide, asserted over real HTTP.
///
/// The credential this replaces failed on exactly this ground and nothing
/// noticed: `acceptRideRequest` returned `plaintextOtp`, the driver-only
/// `POST /rides/accept` sent the whole object, and the only tests that read that
/// field were *depending* on it to start rides. The leak was load-bearing in the
/// suite, so no test could fail because of it.
///
/// These cases are the inverse. They fail if a credential ever comes back out.
describe('Ride PIN — credential containment and start authorization', () => {
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

  /// Books and accepts, then marks the driver arrived — a ride sitting on
  /// DRIVER_ARRIVED, the only state a start may be attempted from.
  async function arrivedRide(
    world: RideWorld,
  ): Promise<{ rideId: string; acceptBody: string; acceptJson: unknown }> {
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9806,
        dropLng: 77.5946,
        paymentMethod: 'CASH',
      },
    });
    assert.equal(requested.statusCode, 200, requested.payload);
    const requestId = requested.json().data.id as string;
    await makeDispatchOffer(requestId, world.driverId);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: world.driver.authHeader,
      payload: { requestId, vehicleId: world.vehicleId },
    });
    assert.equal(accepted.statusCode, 200, accepted.payload);
    const rideId = accepted.json().data.ride.id as string;

    const arrived = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/arrive`,
      headers: world.driver.authHeader,
      payload: {},
    });
    assert.equal(arrived.statusCode, 200, arrived.payload);
    return { rideId, acceptBody: accepted.payload, acceptJson: accepted.json() };
  }

  function status(rideId: string): Promise<string> {
    return db()
      .client.ride.findUniqueOrThrow({ where: { id: rideId } })
      .then((ride) => ride.status);
  }

  it('never returns credential material to the driver who accepts', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790001',
      driver: '+919876790002',
    });
    const { acceptBody, acceptJson } = await arrivedRide(world);

    // The exact regression: `data.plaintextOtp` used to be here and was enough
    // to start the ride with no passenger present.
    assert.equal((acceptJson as { data: Record<string, unknown> }).data.plaintextOtp, undefined);
    assert.deepEqual(Object.keys((acceptJson as { data: Record<string, unknown> }).data), ['ride']);
    assert.ok(!acceptBody.includes(RIDE_PIN), 'the rider PIN must not appear in the accept body');
    assert.ok(
      !/otp|plaintext|"pin"/i.test(acceptBody),
      `no credential field may appear in the accept response: ${acceptBody}`,
    );
  });

  it('never exposes credential material on any ride read, to either party', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790003',
      driver: '+919876790004',
    });
    const { rideId } = await arrivedRide(world);

    for (const [who, headers] of [
      ['driver', world.driver.authHeader],
      ['customer', world.customer.authHeader],
    ] as const) {
      for (const url of [`/api/v1/rides/${rideId}`, '/api/v1/rides/active']) {
        const response = await app.inject({ method: 'GET', url, headers });
        assert.equal(response.statusCode, 200, response.payload);
        assert.ok(
          !response.payload.includes(RIDE_PIN),
          `${who} must not see the PIN on ${url}: ${response.payload}`,
        );
        assert.ok(
          !/otp|plaintext|verifier|scrypt/i.test(response.payload),
          `${who} must not see credential material on ${url}`,
        );
      }
    }
  });

  it('never returns the rider their own PIN, only whether one is set', async () => {
    const user = await loginAs(app, '+919876790005');
    await setRidePin(user.userId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/ride-pin',
      headers: user.authHeader,
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().configured, true);
    // Irreversible by construction — there is nothing to return even to the
    // person who owns it. A forgotten PIN is reset, never recovered.
    assert.ok(!response.payload.includes(RIDE_PIN), response.payload);
    assert.ok(!/verifier|scrypt/i.test(response.payload), response.payload);
  });

  it('starts the ride on the rider’s own PIN', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790006',
      driver: '+919876790007',
    });
    const { rideId } = await arrivedRide(world);

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: world.driver.authHeader,
      payload: { pin: RIDE_PIN },
    });
    assert.equal(started.statusCode, 200, started.payload);
    assert.equal(await status(rideId), 'IN_PROGRESS');
  });

  it('refuses a wrong PIN and leaves the ride where it was', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790008',
      driver: '+919876790009',
    });
    const { rideId } = await arrivedRide(world);

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: world.driver.authHeader,
      payload: { pin: '1937' },
    });
    assert.equal(started.statusCode, 400, started.payload);
    assert.equal(started.json().error.code, 'RIDE_PIN_INVALID');
    assert.ok(!started.payload.includes(RIDE_PIN), 'the error must not disclose the real PIN');
    assert.equal(await status(rideId), 'DRIVER_ARRIVED', 'a refused start changes nothing');
  });

  it('refuses a malformed PIN before it reaches verification', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790010',
      driver: '+919876790011',
    });
    const { rideId } = await arrivedRide(world);

    for (const pin of ['abcd', '123', '12345', '']) {
      const started = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/start`,
        headers: world.driver.authHeader,
        payload: { pin },
      });
      assert.equal(started.statusCode, 400, `${pin}: ${started.payload}`);
      assert.equal(started.json().error.code, 'VALIDATION', started.payload);
    }
    assert.equal(await status(rideId), 'DRIVER_ARRIVED');
  });

  /// Four digits are not unique and are not meant to be. What makes a PIN mean
  /// anything is whose account it is checked against — so the same digits that
  /// start one rider's ride must do nothing on another's.
  it('refuses a PIN that is correct for a different rider', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790012',
      driver: '+919876790013',
    });
    const stranger = await loginAs(app, '+919876790014');
    await setRidePin(stranger.userId, '1938');
    // The rider on this ride keeps the default 4827.
    const { rideId } = await arrivedRide(world);

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: world.driver.authHeader,
      payload: { pin: '1938' },
    });
    assert.equal(started.statusCode, 400, started.payload);
    assert.equal(started.json().error.code, 'RIDE_PIN_INVALID');
    assert.equal(await status(rideId), 'DRIVER_ARRIVED');
  });

  it('refuses the correct PIN from a driver who is not on the ride', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790015',
      driver: '+919876790016',
    });
    const other = await rideWorld(app, {
      customer: '+919876790017',
      driver: '+919876790018',
    });
    const { rideId } = await arrivedRide(world);

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: other.driver.authHeader,
      payload: { pin: RIDE_PIN },
    });
    assert.ok(started.statusCode >= 400, started.payload);
    assert.equal(await status(rideId), 'DRIVER_ARRIVED');
  });

  /// Arrival is not paperwork: it is what says the driver is physically at the
  /// pickup point, and the PIN only means something once they are.
  it('refuses a correct PIN before the driver has arrived', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790019',
      driver: '+919876790020',
    });
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9806,
        dropLng: 77.5946,
        paymentMethod: 'CASH',
      },
    });
    const requestId = requested.json().data.id as string;
    await makeDispatchOffer(requestId, world.driverId);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: world.driver.authHeader,
      payload: { requestId, vehicleId: world.vehicleId },
    });
    const rideId = accepted.json().data.ride.id as string;

    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/start`,
      headers: world.driver.authHeader,
      payload: { pin: RIDE_PIN },
    });
    assert.equal(started.statusCode, 409, started.payload);
    assert.equal(started.json().error.code, 'INVALID_RIDE_STATE_TRANSITION');
    assert.equal(await status(rideId), 'ACCEPTED');
  });

  it('refuses to book a rider who has no PIN configured', async () => {
    const world = await rideWorld(app, {
      customer: '+919876790021',
      driver: '+919876790022',
    });
    await db().client.user.update({
      where: { id: world.customer.userId },
      data: { ridePinVerifier: null },
    });

    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: world.customer.authHeader,
      payload: {
        vehicleTypeId: world.vehicleTypeId,
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 12.9806,
        dropLng: 77.5946,
        paymentMethod: 'CASH',
      },
    });
    // Refused here, where the rider is holding their phone — not at the kerb
    // with a driver already waiting and no way to start.
    assert.equal(requested.statusCode, 422, requested.payload);
    assert.equal(requested.json().error.code, 'RIDE_PIN_NOT_CONFIGURED');
  });
});
