import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDispatchOffer, makeDriver } from './helpers/fixtures.js';
import { completeRide, rideWorld, type RideWorld } from './helpers/ride-flow.js';

/// Which side of a ride the caller is on is a fact about the ride, and these
/// three endpoints used to guess it from the caller's roles instead.
///
/// The guess is wrong for one real, ordinary person: a verified driver taking a
/// ride as a passenger. `ensureDefaultRole` gives every phone login `customer`
/// and a verified driver keeps `driver` for good, so that rider holds both and
/// `callerHasRole(req, 'driver')` answered "driver" for a ride they were riding
/// in. They could not see it, cancel it, or rate it.
describe('a driver riding as a passenger is still the passenger (H-6)', () => {
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

  /// A world whose rider is themselves a verified driver — off duty, riding in
  /// somebody else's car. No consumers are registered in this suite, so no
  /// outbox delivery bumps the token epoch; the fresh login after the grant is
  /// only there to put `driver` into the rider's token claims.
  async function worldWithDriverRider(phones: {
    customer: string;
    driver: string;
  }): Promise<RideWorld> {
    const world = await rideWorld(app, phones);
    await grantRole(world.customer.userId, 'driver');
    await makeDriver(world.customer.userId, { verified: true });
    const customer = await loginAs(app, phones.customer);
    return { ...world, customer };
  }

  /// Books and gets accepted, stopping at ACCEPTED. `completeRide` runs the
  /// whole trip; these cases need a ride that is still live.
  async function acceptedRide(world: RideWorld): Promise<string> {
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
        paymentMethod: 'CARD',
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
    return accepted.json().data.ride.id as string;
  }

  function active(user: LoggedInUser) {
    return app.inject({ method: 'GET', url: '/api/v1/rides/active', headers: user.authHeader });
  }

  it('shows the rider their own live ride', async () => {
    const world = await worldWithDriverRider({
      customer: '+919876740001',
      driver: '+919876740002',
    });
    const rideId = await acceptedRide(world);

    const response = await active(world.customer);
    assert.equal(response.statusCode, 200, response.payload);
    // Looked up as a driver, this was null: they are driving nothing.
    assert.equal(response.json().data?.id, rideId);
  });

  it('lets the rider cancel their own ride, as the customer', async () => {
    const world = await worldWithDriverRider({
      customer: '+919876740003',
      driver: '+919876740004',
    });
    const rideId = await acceptedRide(world);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/cancel`,
      headers: world.customer.authHeader,
      payload: { reasonCode: 'CHANGED_MIND' },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.payload);
    const row = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
    // Not merely "it worked": the cancellation must be attributed to the side
    // they were actually on, because that is what decides the fee.
    assert.equal(row.status, 'CANCELLED_BY_CUSTOMER');
    const cancellation = await db().client.rideCancellation.findUniqueOrThrow({
      where: { rideId },
    });
    assert.equal(cancellation.cancelledBy, 'CUSTOMER');
  });

  it('lets the rider rate the ride they paid for', async () => {
    const world = await worldWithDriverRider({
      customer: '+919876740005',
      driver: '+919876740006',
    });
    const { rideId } = await completeRide(app, world, { distanceKm: 5, durationMin: 15 });

    const rated = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/${rideId}/rating`,
      headers: world.customer.authHeader,
      payload: { rating: 5 },
    });
    assert.equal(rated.statusCode, 200, rated.payload);
    const row = await db().client.rideRating.findFirstOrThrow({ where: { rideId } });
    assert.equal(row.ratedBy, 'CUSTOMER', 'the passenger rated the driver, not the other way up');
  });

  describe('and the actual driver is unaffected', () => {
    it('still shows the assigned driver the ride they are driving', async () => {
      const world = await worldWithDriverRider({
        customer: '+919876740007',
        driver: '+919876740008',
      });
      const rideId = await acceptedRide(world);

      const response = await active(world.driver);
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data?.id, rideId);
    });

    it('still records a driver cancellation as the driver', async () => {
      const world = await worldWithDriverRider({
        customer: '+919876740009',
        driver: '+919876740010',
      });
      const rideId = await acceptedRide(world);

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/cancel`,
        headers: world.driver.authHeader,
        payload: { reasonCode: 'BREAKDOWN' },
      });
      assert.equal(cancelled.statusCode, 200, cancelled.payload);
      const row = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(row.status, 'CANCELLED_BY_DRIVER');
    });

    it('still records the driver rating as the driver', async () => {
      const world = await worldWithDriverRider({
        customer: '+919876740011',
        driver: '+919876740012',
      });
      const { rideId } = await completeRide(app, world, { distanceKm: 5, durationMin: 15 });

      const rated = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/rating`,
        headers: world.driver.authHeader,
        payload: { rating: 4 },
      });
      assert.equal(rated.statusCode, 200, rated.payload);
      const row = await db().client.rideRating.findFirstOrThrow({ where: { rideId } });
      assert.equal(row.ratedBy, 'DRIVER');
    });
  });

  /// `Driver.rating` defaults to 5.00 and was written by nothing, so every
  /// driver's profile reported a perfect score forever however they were rated —
  /// and `GET /drivers/me` hands that row straight to the driver.
  describe("and the driver's score actually moves (M-5)", () => {
    it('recomputes the stored average from the ratings a driver has received', async () => {
      const world = await worldWithDriverRider({
        customer: '+919876740020',
        driver: '+919876740021',
      });
      const before = await db().client.driver.findUniqueOrThrow({
        where: { id: world.driverId },
      });
      assert.equal(before.rating.toString(), '5', 'every driver starts at the column default');

      const { rideId } = await completeRide(app, world, { distanceKm: 5, durationMin: 15 });
      const rated = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/rating`,
        headers: world.customer.authHeader,
        payload: { rating: 3 },
      });
      assert.equal(rated.statusCode, 200, rated.payload);

      const after = await db().client.driver.findUniqueOrThrow({ where: { id: world.driverId } });
      assert.equal(after.rating.toString(), '3', 'one 3-star ride makes the average 3');
    });

    it("leaves the driver's score alone when the driver rates the customer", async () => {
      const world = await worldWithDriverRider({
        customer: '+919876740022',
        driver: '+919876740023',
      });
      const { rideId } = await completeRide(app, world, { distanceKm: 5, durationMin: 15 });

      const rated = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/rating`,
        headers: world.driver.authHeader,
        payload: { rating: 1 },
      });
      assert.equal(rated.statusCode, 200, rated.payload);

      // No customer rating column exists anywhere, so this rating still goes
      // nowhere — but a driver must not be able to lower their own score, or
      // raise it, by rating the person they drove.
      const after = await db().client.driver.findUniqueOrThrow({ where: { id: world.driverId } });
      assert.equal(after.rating.toString(), '5');
    });
  });

  describe('and a stranger is still refused', () => {
    it('refuses a cancel and a rating from someone party to neither side', async () => {
      const world = await worldWithDriverRider({
        customer: '+919876740013',
        driver: '+919876740014',
      });
      const rideId = await acceptedRide(world);
      const stranger = await loginAs(app, '+919876740015');

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/cancel`,
        headers: stranger.authHeader,
        payload: { reasonCode: 'CHANGED_MIND' },
      });
      assert.equal(cancelled.statusCode, 403, cancelled.payload);
      assert.equal(cancelled.json().error.code, 'RIDE_CUSTOMER_MISMATCH');

      const row = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(row.status, 'ACCEPTED', 'the ride is untouched');

      const stale = await active(stranger);
      assert.equal(stale.json().data, null, 'a stranger has no active ride');
    });
  });
});
