import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import {
  completeProfile,
  grantRole,
  makeAssignedVehicle,
  makeDriver,
  makeVehicleType,
} from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { rideConfig } from '../../src/config/ride/ride.config.js';
import { geoConfig } from '../../src/config/geo/geo.config.js';
import type { Unsubscribe } from '../../src/core/events/index.js';
import type { OutboxRelay } from '../../src/core/events/OutboxRelay.js';
import type { DispatchTimeoutJob } from '../../src/modules/rides/jobs/dispatch-timeout.job.js';
import type { RideRequestedConsumer } from '../../src/modules/rides/consumers/ride-requested.consumer.js';

const CENTRE = { latitude: 12.9716, longitude: 77.5946 };
const TRIP = {
  pickupLat: CENTRE.latitude,
  pickupLng: CENTRE.longitude,
  dropLat: 12.9352,
  dropLng: 77.6245,
};

interface OnlineDriver extends LoggedInUser {
  driverId: string;
  vehicleId: string;
}

describe('ride dispatch, offers and assignment (integration)', () => {
  let app: FastifyInstance;
  let unsubscribe: Unsubscribe;

  before(async () => {
    app = await bootApp();
    // `bootstrapEvents()` is what wires consumers to the bus in a running
    // deployment, and the harness boots Fastify with `createApp()` alone — so
    // nothing is subscribed unless a test subscribes it. Registering the one
    // consumer under test here mirrors production wiring without turning on
    // push notifications for every other suite.
    unsubscribe = container.resolve<RideRequestedConsumer>('rideRequestedConsumer').register();
  });
  after(async () => {
    unsubscribe();
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  // ---------------------------------------------------------------- helpers

  async function drainOutbox(): Promise<void> {
    // `ride.requested` is a durable event: the dispatch consumer only sees it
    // once the relay has delivered it. No relay runs in these tests, so each
    // scenario pumps it by hand at the point a real deployment would.
    await container.resolve<OutboxRelay>('outboxRelay').processBatch(200);
  }

  /// `at` places the driver somewhere other than the pickup point, which is how
  /// a search radius becomes observable at all.
  async function onlineDriver(
    phone: string,
    vehicleTypeId: string,
    at: { latitude: number; longitude: number } = CENTRE,
  ): Promise<OnlineDriver> {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, 'driver');
    const user = await loginAs(app, phone);
    const driverId = await makeDriver(user.userId, { verified: true });
    const { vehicleId } = await makeAssignedVehicle(driverId, { vehicleTypeId });

    const online = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: user.authHeader,
      payload: {},
    });
    assert.equal(online.statusCode, 200, online.payload);

    const located = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      headers: user.authHeader,
      payload: at,
    });
    assert.equal(located.statusCode, 200, located.payload);

    return { ...user, driverId, vehicleId };
  }

  async function customerWithProfile(phone: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    const named = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: user.authHeader,
      payload: { firstName: 'Cat', lastName: 'Customer' },
    });
    assert.equal(named.statusCode, 200, named.payload);
    return user;
  }

  /// A customer's request, dispatched — the state every scenario below starts
  /// from. Returns the request and whichever offers the round actually created.
  async function requestRide(
    customer: LoggedInUser,
    vehicleTypeId: string,
  ): Promise<{ requestId: string; offers: { id: string; driverId: string }[] }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: customer.authHeader,
      payload: { vehicleTypeId, ...TRIP },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const requestId = created.json().data.id as string;
    await drainOutbox();
    return { requestId, offers: await offersFor(requestId) };
  }

  async function offersFor(requestId: string): Promise<{ id: string; driverId: string }[]> {
    const rows = await db().client.rideDispatch.findMany({
      where: { requestId },
      orderBy: { offeredAt: 'asc' },
    });
    return rows.map((row) => ({ id: row.id, driverId: row.driverId }));
  }

  function offerOf(
    offers: { id: string; driverId: string }[],
    driver: OnlineDriver,
  ): { id: string; driverId: string } {
    const offer = offers.find((entry) => entry.driverId === driver.driverId);
    assert.ok(offer, `expected an offer for driver ${driver.driverId}`);
    return offer;
  }

  function reject(driver: LoggedInUser, dispatchId: string, reason?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/rides/offers/${dispatchId}/reject`,
      headers: driver.authHeader,
      payload: reason !== undefined ? { reason } : {},
    });
  }

  function accept(driver: OnlineDriver, requestId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: driver.authHeader,
      payload: { requestId, vehicleId: driver.vehicleId },
    });
  }

  async function responseOf(dispatchId: string): Promise<string> {
    const row = await db().client.rideDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
    return row.response;
  }

  function runTimeoutJob(): Promise<number> {
    return container.resolve<DispatchTimeoutJob>('dispatchTimeoutJob').run();
  }

  /// Drags every live offer for a request back past its window, so the timeout
  /// job has something to sweep without the test sleeping for 30 seconds.
  async function expireOffers(requestId: string): Promise<void> {
    await db().client.rideDispatch.updateMany({
      where: { requestId, response: 'PENDING' },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
  }

  // ------------------------------------------------------------ the scenarios

  /// One degree of longitude is about 108.5km at this latitude, which is all the
  /// arithmetic needed to put a driver a chosen distance due east of the pickup.
  function eastOfCentre(metres: number): { latitude: number; longitude: number } {
    return { latitude: CENTRE.latitude, longitude: CENTRE.longitude + metres / 108_500 };
  }

  /// The unit suite checks which radii dispatch asks for; this checks that the
  /// radius reaches the geo query at all — the Redis cell cover and the PostGIS
  /// `ST_DWithin` both have to honour it, and neither is exercised by a fake.
  describe('a driver beyond the default search radius (M-7)', () => {
    it('is found by widening, and is not found without it', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `FAR_${randomUUID().slice(0, 6)}` });
      const far = await onlineDriver(
        '+919876730801',
        vehicleTypeId,
        // Comfortably outside GEO_SEARCH_RADIUS_M, comfortably inside the maximum.
        eastOfCentre(geoConfig.searchRadiusMeters + 2000),
      );
      const customer = await customerWithProfile('+919876730802');

      const { requestId, offers } = await requestRide(customer, vehicleTypeId);

      assert.deepEqual(
        offers.map((offer) => offer.driverId),
        [far.driverId],
        'the only driver in the city was beyond the first circle, not beyond reach',
      );
      const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(request.status, 'SEARCHING');

      // The control for the claim above: the same driver is genuinely outside
      // the default radius, so this is widening finding them and not the
      // default circle having been wide enough all along.
      const geo = container.resolve<{
        findNearbyDrivers(search: unknown): Promise<{ outcome: string; drivers?: unknown[] }>;
      }>('geoService');
      const atDefault = await geo.findNearbyDrivers({
        origin: CENTRE,
        radiusMeters: geoConfig.searchRadiusMeters,
      });
      assert.equal(atDefault.drivers?.length ?? 0, 0, 'not inside the default circle');
    });

    it('is left alone when a nearer driver can take the ride', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `NEAR_${randomUUID().slice(0, 6)}` });
      const near = await onlineDriver('+919876730803', vehicleTypeId);
      await onlineDriver(
        '+919876730804',
        vehicleTypeId,
        eastOfCentre(geoConfig.searchRadiusMeters + 2000),
      );
      const customer = await customerWithProfile('+919876730805');

      const { offers } = await requestRide(customer, vehicleTypeId);

      assert.deepEqual(
        offers.map((offer) => offer.driverId),
        [near.driverId],
        'widening is a fallback, not a reason to drag a distant driver into round one',
      );
    });
  });

  describe('parallel dispatch', () => {
    it('offers one request to several nearby drivers at once', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BATCH_${randomUUID().slice(0, 6)}` });
      await onlineDriver('+919876730001', vehicleTypeId);
      await onlineDriver('+919876730002', vehicleTypeId);
      await onlineDriver('+919876730003', vehicleTypeId);
      const customer = await customerWithProfile('+919876730004');

      const { offers } = await requestRide(customer, vehicleTypeId);

      assert.equal(offers.length, 3, 'all three drivers were asked in one round');
      assert.equal(
        new Set(offers.map((offer) => offer.driverId)).size,
        3,
        'and each of them exactly once',
      );
      const rows = await db().client.rideDispatch.findMany({ where: { response: 'PENDING' } });
      assert.equal(rows.length, 3);
      assert.ok(
        rows.every((row) => row.dispatchRound === 1 && row.expiresAt !== null),
        'one round, every offer given a window',
      );
    });

    it('moves the request to SEARCHING once drivers have been asked', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `SRCH_${randomUUID().slice(0, 6)}` });
      await onlineDriver('+919876730005', vehicleTypeId);
      const customer = await customerWithProfile('+919876730006');

      const { requestId } = await requestRide(customer, vehicleTypeId);

      const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(request.status, 'SEARCHING');
    });

    it('never offers a request to a driver whose vehicle is the wrong category', async () => {
      const wanted = await makeVehicleType({ code: `WANT_${randomUUID().slice(0, 6)}` });
      const other = await makeVehicleType({ code: `OTHR_${randomUUID().slice(0, 6)}` });
      const matching = await onlineDriver('+919876730007', wanted);
      await onlineDriver('+919876730008', other);
      const customer = await customerWithProfile('+919876730009');

      const { offers } = await requestRide(customer, wanted);

      assert.deepEqual(
        offers.map((offer) => offer.driverId),
        [matching.driverId],
        'a driver who could never accept must not burn an offer slot',
      );
    });

    it('never offers a request to an offline driver', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `OFFL_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730010', vehicleTypeId);
      const wentOffline = await app.inject({
        method: 'POST',
        url: '/api/v1/drivers/status/offline',
        headers: driver.authHeader,
        payload: {},
      });
      assert.equal(wentOffline.statusCode, 200, wentOffline.payload);
      const customer = await customerWithProfile('+919876730011');

      const { offers } = await requestRide(customer, vehicleTypeId);
      assert.equal(offers.length, 0);
    });

    it('never offers a request to a driver whose vehicle is not verified', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `UNVF_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730012', vehicleTypeId);
      await db().client.vehicle.update({
        where: { id: driver.vehicleId },
        data: { verificationStatus: 'PENDING' },
      });
      const customer = await customerWithProfile('+919876730013');

      const { offers } = await requestRide(customer, vehicleTypeId);
      assert.equal(offers.length, 0);
    });

    it('never offers a request to a driver already on another ride', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BUSY_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730014', vehicleTypeId);
      const first = await customerWithProfile('+919876730015');

      const firstRide = await requestRide(first, vehicleTypeId);
      const accepted = await accept(driver, firstRide.requestId);
      assert.equal(accepted.statusCode, 200, accepted.payload);

      const second = await customerWithProfile('+919876730016');
      const secondRide = await requestRide(second, vehicleTypeId);
      assert.equal(secondRide.offers.length, 0, 'a driver mid-trip must not be offered another');
    });

    it('lists a live offer to the driver it was made to, and nobody else', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `LIST_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730017', vehicleTypeId);
      const bystander = await onlineDriver('+919876730018', vehicleTypeId);
      const customer = await customerWithProfile('+919876730019');
      await requestRide(customer, vehicleTypeId);

      const mine = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/offers',
        headers: driver.authHeader,
      });
      assert.equal(mine.statusCode, 200, mine.payload);
      assert.equal(mine.json().data.length, 1);

      const theirs = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/offers',
        headers: bystander.authHeader,
      });
      assert.equal(theirs.json().data.length, 1, 'the batch reached them too');
      assert.notEqual(mine.json().data[0].id, theirs.json().data[0].id);
    });
  });

  describe('driver reject', () => {
    it('records the rejection and asks the next driver immediately', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `REJ_${randomUUID().slice(0, 6)}` });
      const first = await onlineDriver('+919876730020', vehicleTypeId);
      await onlineDriver('+919876730021', vehicleTypeId);
      const spare = await onlineDriver('+919876730022', vehicleTypeId);
      const customer = await customerWithProfile('+919876730023');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      assert.equal(offers.length, 3, 'the batch filled first');
      const spareOffer = offers.find((offer) => offer.driverId === spare.driverId);
      assert.ok(spareOffer);

      const response = await reject(first, offerOf(offers, first).id, 'TOO_FAR');

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.response, 'REJECTED');
      const row = await db().client.rideDispatch.findUniqueOrThrow({
        where: { id: offerOf(offers, first).id },
      });
      assert.equal(row.response, 'REJECTED');
      assert.equal(row.rejectReason, 'TOO_FAR');
      assert.ok(row.respondedAt, 'the rejection is timestamped');
      // Everyone eligible already held an offer, so there is nobody left to
      // promote — but the request must still be searching, not stalled.
      const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(request.status, 'SEARCHING');
    });

    it('promotes a fresh driver into the freed slot without waiting for the cron', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `PROM_${randomUUID().slice(0, 6)}` });
      const a = await onlineDriver('+919876730024', vehicleTypeId);
      await onlineDriver('+919876730025', vehicleTypeId);
      await onlineDriver('+919876730026', vehicleTypeId);
      const fourth = await onlineDriver('+919876730027', vehicleTypeId);
      const customer = await customerWithProfile('+919876730028');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      assert.equal(offers.length, 3, 'batch size caps the first round at three');
      assert.ok(
        !offers.some((offer) => offer.driverId === fourth.driverId),
        'the fourth driver is waiting outside the batch',
      );

      const rejected = await reject(a, offerOf(offers, a).id);
      assert.equal(rejected.statusCode, 200, rejected.payload);

      const after = await offersFor(requestId);
      assert.equal(after.length, 4, 'the freed slot was refilled at once');
      assert.ok(
        after.some((offer) => offer.driverId === fourth.driverId),
        'and it went to the driver who had not been asked yet',
      );
    });

    it('never re-offers the request to a driver who rejected it', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EXCL_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730029', vehicleTypeId);
      const customer = await customerWithProfile('+919876730030');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);

      await reject(driver, offerOf(offers, driver).id);
      await expireOffers(requestId);
      await runTimeoutJob();

      const all = await offersFor(requestId);
      assert.equal(
        all.filter((offer) => offer.driverId === driver.driverId).length,
        1,
        'a rejecting driver is excluded from every later round',
      );
    });

    it('is idempotent when a flaky client sends the rejection twice', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `IDEM_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730031', vehicleTypeId);
      const customer = await customerWithProfile('+919876730032');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      const dispatchId = offerOf(offers, driver).id;

      const first = await reject(driver, dispatchId, 'TOO_FAR');
      const countAfterFirst = (await offersFor(requestId)).length;
      const second = await reject(driver, dispatchId, 'CHANGED_MIND');

      assert.equal(first.statusCode, 200, first.payload);
      assert.equal(second.statusCode, 200, second.payload);
      assert.equal(second.json().data.response, 'REJECTED');
      const row = await db().client.rideDispatch.findUniqueOrThrow({ where: { id: dispatchId } });
      assert.equal(row.rejectReason, 'TOO_FAR', 'the first reason stands');
      assert.equal(
        (await offersFor(requestId)).length,
        countAfterFirst,
        'a retry must not kick off another dispatch round',
      );
    });

    it('refuses to let one driver reject another driver’s offer', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BOLA_${randomUUID().slice(0, 6)}` });
      const owner = await onlineDriver('+919876730033', vehicleTypeId);
      const attacker = await onlineDriver('+919876730034', vehicleTypeId);
      const customer = await customerWithProfile('+919876730035');
      const { offers } = await requestRide(customer, vehicleTypeId);

      const response = await reject(attacker, offerOf(offers, owner).id);

      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'RIDE_OFFER_MISMATCH');
      assert.equal(await responseOf(offerOf(offers, owner).id), 'PENDING');
    });

    it('404s on an offer that does not exist', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `GONE_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730036', vehicleTypeId);

      const response = await reject(driver, randomUUID());
      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(response.json().error.code, 'RIDE_OFFER_NOT_FOUND');
    });

    it('refuses a rejection once the offer has already timed out', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `LATE_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730037', vehicleTypeId);
      const customer = await customerWithProfile('+919876730038');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      const dispatchId = offerOf(offers, driver).id;
      await expireOffers(requestId);
      await runTimeoutJob();

      const response = await reject(driver, dispatchId);
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'RIDE_OFFER_NOT_ACTIONABLE');
      assert.equal(await responseOf(dispatchId), 'TIMEOUT');
    });
  });

  describe('atomic acceptance', () => {
    it('lets exactly one of two racing drivers win, and closes the loser’s offer', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RACE_${randomUUID().slice(0, 6)}` });
      const a = await onlineDriver('+919876730039', vehicleTypeId);
      const b = await onlineDriver('+919876730040', vehicleTypeId);
      const customer = await customerWithProfile('+919876730041');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      assert.equal(offers.length, 2, 'both drivers hold a live offer');

      const [first, second] = await Promise.all([accept(a, requestId), accept(b, requestId)]);

      const codes = [first.statusCode, second.statusCode].sort();
      assert.deepEqual(
        codes,
        [200, 409],
        `one winner, one loser: ${first.payload} ${second.payload}`,
      );
      assert.equal(await db().client.ride.count({ where: { requestId } }), 1);

      const responses = (await db().client.rideDispatch.findMany({ where: { requestId } })).map(
        (row) => row.response,
      );
      assert.deepEqual(responses.slice().sort(), ['ACCEPTED', 'CANCELLED']);
    });

    it('refuses a driver who was never offered the request', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `NOFF_${randomUUID().slice(0, 6)}` });
      const offered = await onlineDriver('+919876730042', vehicleTypeId);
      const outsider = await onlineDriver('+919876730043', vehicleTypeId);
      const customer = await customerWithProfile('+919876730044');
      const { requestId } = await requestRide(customer, vehicleTypeId);
      // Take the outsider's own offer out of the way so only "was I offered
      // this?" is under test.
      await db().client.rideDispatch.deleteMany({
        where: { requestId, driverId: outsider.driverId },
      });
      assert.ok(offered.driverId !== outsider.driverId);

      const response = await accept(outsider, requestId);

      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(response.json().error.code, 'RIDE_OFFER_NOT_FOUND');
      assert.equal(await db().client.ride.count({ where: { requestId } }), 0);
    });

    it('refuses an offer whose window has already passed', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EXPD_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730045', vehicleTypeId);
      const customer = await customerWithProfile('+919876730046');
      const { requestId } = await requestRide(customer, vehicleTypeId);
      await expireOffers(requestId);

      const response = await accept(driver, requestId);

      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'RIDE_OFFER_NOT_ACTIONABLE');
      assert.equal(await db().client.ride.count({ where: { requestId } }), 0);
    });

    it('refuses an accept from a driver who has already rejected', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RJAC_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730047', vehicleTypeId);
      const customer = await customerWithProfile('+919876730048');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);

      await reject(driver, offerOf(offers, driver).id);
      const response = await accept(driver, requestId);

      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'RIDE_OFFER_NOT_ACTIONABLE');
      assert.equal(await db().client.ride.count({ where: { requestId } }), 0);
    });

    it('refuses an accept after the customer cancelled the request', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `CANC_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730049', vehicleTypeId);
      const customer = await customerWithProfile('+919876730050');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/requests/${requestId}/cancel`,
        headers: customer.authHeader,
        payload: {},
      });
      assert.equal(cancelled.statusCode, 200, cancelled.payload);
      // Cancelling closes every live offer, which is what turns the driver away.
      assert.equal(await responseOf(offerOf(offers, driver).id), 'CANCELLED');

      const response = await accept(driver, requestId);
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(await db().client.ride.count({ where: { requestId } }), 0);
    });

    it('refuses an accept from a driver who went offline holding the offer', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `WOFF_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730051', vehicleTypeId);
      const customer = await customerWithProfile('+919876730052');
      const { requestId } = await requestRide(customer, vehicleTypeId);

      await app.inject({
        method: 'POST',
        url: '/api/v1/drivers/status/offline',
        headers: driver.authHeader,
        payload: {},
      });

      const response = await accept(driver, requestId);
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'DRIVER_NOT_AVAILABLE');
      assert.equal(await db().client.ride.count({ where: { requestId } }), 0);
    });

    it('puts the winner ON_TRIP and creates exactly one ride', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `WIN_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730053', vehicleTypeId);
      const customer = await customerWithProfile('+919876730054');
      const { requestId } = await requestRide(customer, vehicleTypeId);

      const response = await accept(driver, requestId);
      assert.equal(response.statusCode, 200, response.payload);

      const status = await db().client.driverOnlineStatus.findUniqueOrThrow({
        where: { driverId: driver.driverId },
      });
      assert.equal(status.status, 'ON_TRIP');
      const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(request.status, 'MATCHED');
    });
  });

  describe('offer timeout', () => {
    it('times out every expired offer and re-dispatches the request exactly once', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `TMO_${randomUUID().slice(0, 6)}` });
      await onlineDriver('+919876730055', vehicleTypeId);
      await onlineDriver('+919876730056', vehicleTypeId);
      await onlineDriver('+919876730057', vehicleTypeId);
      const spare = await onlineDriver('+919876730058', vehicleTypeId);
      const customer = await customerWithProfile('+919876730059');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      assert.equal(offers.length, 3);
      await expireOffers(requestId);

      const expired = await runTimeoutJob();

      assert.equal(expired, 3, 'all three offers were swept');
      const after = await offersFor(requestId);
      assert.equal(after.length, 4, 'three timeouts must trigger one re-dispatch round, not three');
      assert.ok(after.some((offer) => offer.driverId === spare.driverId));
      const live = await db().client.rideDispatch.count({
        where: { requestId, response: 'PENDING' },
      });
      assert.equal(live, 1, 'only the one remaining driver holds a live offer');
    });

    it('does not re-dispatch a request the customer already cancelled', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `TCAN_${randomUUID().slice(0, 6)}` });
      await onlineDriver('+919876730060', vehicleTypeId);
      const customer = await customerWithProfile('+919876730062');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      assert.equal(offers.length, 1);

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/requests/${requestId}/cancel`,
        headers: customer.authHeader,
        payload: {},
      });
      assert.equal(cancelled.statusCode, 200, cancelled.payload);

      // A driver who comes online only now would be the obvious next candidate,
      // so if the request were still dispatchable they would certainly be asked.
      const spare = await onlineDriver('+919876730061', vehicleTypeId);
      // Drag the cancelled offer back into a state the sweeper would pick up.
      await db().client.rideDispatch.updateMany({
        where: { requestId },
        data: { response: 'PENDING', expiresAt: new Date(Date.now() - 60_000) },
      });

      await runTimeoutJob();

      const after = await offersFor(requestId);
      assert.ok(
        !after.some((offer) => offer.driverId === spare.driverId),
        'an abandoned request must not keep pulling drivers in',
      );
      assert.equal(after.length, 1, 'no new offer at all');
    });

    it('does not re-dispatch a request another driver already accepted', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `TACC_${randomUUID().slice(0, 6)}` });
      const winner = await onlineDriver('+919876730063', vehicleTypeId);
      const loser = await onlineDriver('+919876730064', vehicleTypeId);
      const customer = await customerWithProfile('+919876730065');
      const { requestId } = await requestRide(customer, vehicleTypeId);

      const accepted = await accept(winner, requestId);
      assert.equal(accepted.statusCode, 200, accepted.payload);
      // Force the loser's now-CANCELLED offer back to a state the job would
      // sweep, to prove the guard is the request status and not luck.
      await db().client.rideDispatch.updateMany({
        where: { requestId, driverId: loser.driverId },
        data: { response: 'PENDING', expiresAt: new Date(Date.now() - 60_000) },
      });

      await runTimeoutJob();

      assert.equal(await db().client.ride.count({ where: { requestId } }), 1);
      assert.equal(
        (await offersFor(requestId)).length,
        2,
        'a matched request must not be dispatched again',
      );
    });

    it('leaves the database consistent when two timeout runs overlap', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `TDUP_${randomUUID().slice(0, 6)}` });
      await onlineDriver('+919876730066', vehicleTypeId);
      await onlineDriver('+919876730067', vehicleTypeId);
      const customer = await customerWithProfile('+919876730068');
      const { requestId } = await requestRide(customer, vehicleTypeId);
      await expireOffers(requestId);

      const [a, b] = await Promise.all([runTimeoutJob(), runTimeoutJob()]);

      // The job's own Redis lock means one run does the work and the other is a
      // no-op; either way no offer may be timed out twice.
      assert.equal(a + b, 2, 'each expired offer counted exactly once across both runs');
      const rows = await db().client.rideDispatch.findMany({ where: { requestId } });
      assert.ok(rows.every((row) => row.response !== 'PENDING' || row.expiresAt! > new Date()));
      const drivers = rows.map((row) => row.driverId);
      assert.equal(new Set(drivers).size, drivers.length, 'no driver got a duplicate offer');
    });

    it('does not steal an offer a driver accepted in the same instant', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `TRAC_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730069', vehicleTypeId);
      const customer = await customerWithProfile('+919876730070');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);
      await expireOffers(requestId);

      // The offer is past its window, so accepting must lose — and the sweep
      // must still leave exactly one coherent outcome behind.
      const [accepted] = await Promise.all([accept(driver, requestId), runTimeoutJob()]);

      assert.equal(accepted.statusCode, 409, accepted.payload);
      assert.equal(await db().client.ride.count({ where: { requestId } }), 0);
      assert.equal(await responseOf(offerOf(offers, driver).id), 'TIMEOUT');
    });
  });

  describe('DRIVER_ARRIVING', () => {
    async function acceptedRide(
      phones: { driver: string; customer: string },
      code: string,
    ): Promise<{ driver: OnlineDriver; customer: LoggedInUser; rideId: string }> {
      const vehicleTypeId = await makeVehicleType({ code });
      const driver = await onlineDriver(phones.driver, vehicleTypeId);
      const customer = await customerWithProfile(phones.customer);
      const { requestId } = await requestRide(customer, vehicleTypeId);
      const accepted = await accept(driver, requestId);
      assert.equal(accepted.statusCode, 200, accepted.payload);
      return { driver, customer, rideId: accepted.json().data.ride.id as string };
    }

    function arriving(user: LoggedInUser, rideId: string) {
      return app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arriving`,
        headers: user.authHeader,
        payload: {},
      });
    }

    it('lets the assigned driver report they are on the way', async () => {
      const { driver, rideId } = await acceptedRide(
        { driver: '+919876730071', customer: '+919876730072' },
        `ARV_${randomUUID().slice(0, 6)}`,
      );

      const response = await arriving(driver, rideId);

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.status, 'DRIVER_ARRIVING');
      const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(ride.status, 'DRIVER_ARRIVING');
      const events = await db().client.rideStatusEvent.findMany({ where: { rideId } });
      assert.ok(events.some((event) => event.toStatus === 'DRIVER_ARRIVING'));
    });

    it('carries on to DRIVER_ARRIVED and then into the trip', async () => {
      const { driver, rideId } = await acceptedRide(
        { driver: '+919876730073', customer: '+919876730074' },
        `FLOW_${randomUUID().slice(0, 6)}`,
      );

      assert.equal((await arriving(driver, rideId)).statusCode, 200);
      const arrived = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arrive`,
        headers: driver.authHeader,
        payload: {},
      });
      assert.equal(arrived.statusCode, 200, arrived.payload);
      assert.equal(arrived.json().data.status, 'DRIVER_ARRIVED');
    });

    it('refuses a customer trying to declare the driver on the way', async () => {
      const { customer, rideId } = await acceptedRide(
        { driver: '+919876730075', customer: '+919876730076' },
        `CUST_${randomUUID().slice(0, 6)}`,
      );

      const response = await arriving(customer, rideId);

      // The route is driver-only, so a customer never even reaches the service.
      assert.equal(response.statusCode, 403, response.payload);
      const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(ride.status, 'ACCEPTED');
    });

    it('refuses a driver who is not the one assigned', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `OTHD_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730077', vehicleTypeId);
      const intruder = await onlineDriver('+919876730078', vehicleTypeId);
      const customer = await customerWithProfile('+919876730079');
      const { requestId } = await requestRide(customer, vehicleTypeId);
      const accepted = await accept(driver, requestId);
      const rideId = accepted.json().data.ride.id as string;

      const response = await arriving(intruder, rideId);

      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(response.json().error.code, 'RIDE_DRIVER_MISMATCH');
    });

    it('refuses to go back to DRIVER_ARRIVING once already arrived', async () => {
      const { driver, rideId } = await acceptedRide(
        { driver: '+919876730080', customer: '+919876730081' },
        `BACK_${randomUUID().slice(0, 6)}`,
      );
      await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arrive`,
        headers: driver.authHeader,
        payload: {},
      });

      const response = await arriving(driver, rideId);

      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'INVALID_RIDE_STATE_TRANSITION');
    });

    it('still lets either party cancel from DRIVER_ARRIVING', async () => {
      const { driver, customer, rideId } = await acceptedRide(
        { driver: '+919876730082', customer: '+919876730083' },
        `ACAN_${randomUUID().slice(0, 6)}`,
      );
      assert.equal((await arriving(driver, rideId)).statusCode, 200);

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/cancel`,
        headers: customer.authHeader,
        payload: { reasonCode: 'CHANGED_MIND' },
      });

      assert.equal(cancelled.statusCode, 200, cancelled.payload);
      assert.equal(cancelled.json().data.status, 'CANCELLED_BY_CUSTOMER');
      const status = await db().client.driverOnlineStatus.findUniqueOrThrow({
        where: { driverId: driver.driverId },
      });
      assert.equal(status.status, 'ONLINE', 'the driver is freed again');
    });

    /// The fee a post-arrival customer cancellation attracts is *assessed*, and
    /// the row has to say so. Collecting it is an explicit non-goal of the
    /// payment feature (spec.md non-goals; decisions.md scopes collection to a
    /// COMPLETED ride), and `feeCharged: true` asserted money had changed hands
    /// that nothing had taken.
    it('records a post-arrival cancellation fee as assessed, not charged', async () => {
      const { driver, customer, rideId } = await acceptedRide(
        { driver: '+919876730104', customer: '+919876730105' },
        `FEE_${randomUUID().slice(0, 6)}`,
      );
      const arrived = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arrive`,
        headers: driver.authHeader,
        payload: {},
      });
      assert.equal(arrived.statusCode, 200, arrived.payload);

      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/cancel`,
        headers: customer.authHeader,
        payload: { reasonCode: 'CHANGED_MIND' },
      });
      assert.equal(cancelled.statusCode, 200, cancelled.payload);

      const row = await db().client.rideCancellation.findUniqueOrThrow({ where: { rideId } });
      assert.equal(row.cancellationFee.toString(), String(rideConfig.defaultCancellationFee));
      assert.equal(row.feeCharged, false, 'nothing charged this fee');

      // And the record must match reality: no payment attempt, no ledger entry,
      // and the ride's own obligation untouched.
      assert.equal(await db().client.ridePayment.count({ where: { rideId } }), 0);
      assert.equal(
        await db().client.paymentLedgerEntry.count({ where: { referenceId: rideId } }),
        0,
      );
      const ride = await db().client.ride.findUniqueOrThrow({ where: { id: rideId } });
      assert.equal(ride.paymentStatus, 'PENDING');
    });

    it('assesses no fee when the customer cancels before the driver arrives', async () => {
      const { customer, rideId } = await acceptedRide(
        { driver: '+919876730106', customer: '+919876730107' },
        `NOFEE_${randomUUID().slice(0, 6)}`,
      );
      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/cancel`,
        headers: customer.authHeader,
        payload: { reasonCode: 'CHANGED_MIND' },
      });
      assert.equal(cancelled.statusCode, 200, cancelled.payload);

      const row = await db().client.rideCancellation.findUniqueOrThrow({ where: { rideId } });
      assert.equal(row.cancellationFee.toString(), '0');
      assert.equal(row.feeCharged, false);
    });
  });

  describe('events', () => {
    it('publishes the dispatch and assignment events the realtime layer will need', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EVT_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730084', vehicleTypeId);
      const customer = await customerWithProfile('+919876730085');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);

      const accepted = await accept(driver, requestId);
      const rideId = accepted.json().data.ride.id as string;
      await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arriving`,
        headers: driver.authHeader,
        payload: {},
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arrive`,
        headers: driver.authHeader,
        payload: {},
      });

      const types = (await db().client.outboxEvent.findMany({ select: { eventType: true } })).map(
        (row) => row.eventType,
      );
      for (const expected of [
        'ride.requested',
        'ride.dispatch.offered',
        'ride.accepted',
        'ride.driver_arriving',
        'ride.driver_arrived',
      ]) {
        assert.ok(types.includes(expected), `expected ${expected} on the outbox, got ${types}`);
      }
      assert.ok(offers.length > 0);
    });

    it('publishes a rejection event and an expiry event', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EVT2_${randomUUID().slice(0, 6)}` });
      const a = await onlineDriver('+919876730086', vehicleTypeId);
      const b = await onlineDriver('+919876730087', vehicleTypeId);
      const customer = await customerWithProfile('+919876730088');
      const { requestId, offers } = await requestRide(customer, vehicleTypeId);

      await reject(a, offerOf(offers, a).id, 'TOO_FAR');
      await expireOffers(requestId);
      await runTimeoutJob();

      const types = (await db().client.outboxEvent.findMany({ select: { eventType: true } })).map(
        (row) => row.eventType,
      );
      assert.ok(types.includes('ride.dispatch.rejected'));
      assert.ok(types.includes('ride.dispatch.expired'));
      assert.ok(b.driverId);
    });
  });

  describe('malformed input', () => {
    /// Every `:id` here lands in a `::uuid` cast. Before the router validated
    /// the shape, a non-UUID reached Postgres and came back as 500 INTERNAL — a
    /// client mistake reported as a server fault.
    it('answers a malformed offer id with 400, not 500', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BAD_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730090', vehicleTypeId);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/offers/not-a-uuid/reject',
        headers: driver.authHeader,
        payload: {},
      });
      assert.equal(response.statusCode, 400, response.payload);
    });

    it('answers a malformed ride id with 400 on every id-bearing route', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BAD2_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730091', vehicleTypeId);

      for (const path of ['arriving', 'arrive', 'start', 'complete']) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/rides/not-a-uuid/${path}`,
          headers: driver.authHeader,
          payload: {},
        });
        assert.equal(response.statusCode, 400, `${path}: ${response.payload}`);
      }
    });

    it('still 404s a well-formed offer id that does not exist', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BAD3_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730092', vehicleTypeId);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/rides/offers/${randomUUID()}/reject`,
        headers: driver.authHeader,
        payload: {},
      });
      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(response.json().error.code, 'RIDE_OFFER_NOT_FOUND');
    });

    it('never exposes a stack trace in an error envelope', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BAD4_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730093', vehicleTypeId);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/offers/not-a-uuid/reject',
        headers: driver.authHeader,
        payload: {},
      });
      assert.ok(!response.payload.includes('at '), 'no stack frames');
      assert.ok(!/\.ts:\d+/.test(response.payload), 'no source locations');
    });
  });

  describe('stale offer visibility', () => {
    /// A dispatch round can commit an offer moments before another driver's
    /// accept claims the request. `resolveOffers` only closes what existed when
    /// it ran, so a PENDING row can outlive its request — the driver app must
    /// not render an offer whose only outcome is RIDE_REQUEST_ALREADY_MATCHED.
    it('hides an offer whose request has already been matched', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `STL_${randomUUID().slice(0, 6)}` });
      const winner = await onlineDriver('+919876730094', vehicleTypeId);
      const loser = await onlineDriver('+919876730095', vehicleTypeId);
      const customer = await customerWithProfile('+919876730096');
      const { requestId } = await requestRide(customer, vehicleTypeId);

      const accepted = await accept(winner, requestId);
      assert.equal(accepted.statusCode, 200, accepted.payload);

      // Force the loser's offer back to PENDING, the state a racing round would
      // have left behind.
      await db().client.rideDispatch.updateMany({
        where: { requestId, driverId: loser.driverId },
        data: { response: 'PENDING', respondedAt: null },
      });

      const offers = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/offers',
        headers: loser.authHeader,
      });
      assert.equal(offers.statusCode, 200, offers.payload);
      assert.equal(offers.json().data.length, 0, 'a matched request must not be offered');
    });

    it('still lists a live offer for a searching request', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `STL2_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730097', vehicleTypeId);
      const customer = await customerWithProfile('+919876730098');
      await requestRide(customer, vehicleTypeId);

      const offers = await app.inject({
        method: 'GET',
        url: '/api/v1/rides/offers',
        headers: driver.authHeader,
      });
      assert.equal(offers.json().data.length, 1);
    });
  });

  /// A driver holds the `customer` role too — `ensureDefaultRole` grants it on
  /// every phone login — so nothing on the booking route distinguishes them
  /// from a rider, and dispatch ranks their own record as the nearest driver to
  /// their own pickup point. Both halves are legitimate on their own; the
  /// combination lets one account manufacture a completed ride, a fare, a driver
  /// earning and a commission entry for a journey nobody took.
  describe('a driver may not ride with themselves (H-1)', () => {
    it('offers the request back to the driver who booked it, then refuses the accept', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `SELF_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876730101', vehicleTypeId);
      // Booking needs a profile name, same as any rider's would.
      await completeProfile(driver.userId, 'Dee', 'Driver');

      // The same token books the ride. This is the step no role gate can catch.
      const { requestId, offers } = await requestRide(driver, vehicleTypeId);
      const own = offerOf(offers, driver);
      assert.ok(own, 'dispatch does offer a driver their own request — accept is the gate');

      const accepted = await accept(driver, requestId);
      assert.equal(accepted.statusCode, 403, accepted.payload);
      assert.equal(accepted.json().error.code, 'SELF_RIDE_NOT_ALLOWED');

      // Nothing may have been minted, and the request must stay open for a real
      // driver rather than being burnt by the attempt.
      assert.equal(await db().client.ride.count({ where: { requestId } }), 0);
      const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(request.status, 'SEARCHING');
      assert.equal(await responseOf(own.id), 'PENDING');
    });

    it('still lets a different driver accept that same request', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `SELF2_${randomUUID().slice(0, 6)}` });
      const booking = await onlineDriver('+919876730102', vehicleTypeId);
      const other = await onlineDriver('+919876730103', vehicleTypeId);
      await completeProfile(booking.userId, 'Dee', 'Driver');

      const { requestId, offers } = await requestRide(booking, vehicleTypeId);
      assert.equal((await accept(booking, requestId)).statusCode, 403);

      const accepted = await accept(other, requestId);
      assert.equal(accepted.statusCode, 200, accepted.payload);
      const ride = await db().client.ride.findFirstOrThrow({ where: { requestId } });
      assert.equal(ride.driverId, other.driverId);
      assert.equal(await responseOf(offerOf(offers, other).id), 'ACCEPTED');
    });
  });

  /// `Promotion` and `PromotionRedemption` are fully modelled and referenced
  /// nowhere in `src`. Redeeming them is out of scope by decision, but the API
  /// accepted a code anyway, stored it on the request and billed the customer
  /// in full — a rider who typed a code was quietly charged the undiscounted
  /// fare with nothing in the response to tell them.
  describe('a promo code the platform cannot honour (M-3)', () => {
    it('refuses the booking rather than charging full price in silence', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `PROMO_${randomUUID().slice(0, 6)}` });
      const customer = await customerWithProfile('+919876730120');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/requests',
        headers: customer.authHeader,
        payload: { vehicleTypeId, ...TRIP, promoCode: 'SUMMER50' },
      });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PROMOTIONS_UNAVAILABLE');
      assert.equal(await db().client.rideRequest.count(), 0, 'nothing may be written');
    });

    it('treats an empty code as no code, so a client sending one is not broken', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `BLANK_${randomUUID().slice(0, 6)}` });
      const customer = await customerWithProfile('+919876730121');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/requests',
        headers: customer.authHeader,
        payload: { vehicleTypeId, ...TRIP, promoCode: '   ' },
      });

      assert.equal(response.statusCode, 200, response.payload);
      const request = await db().client.rideRequest.findUniqueOrThrow({
        where: { id: response.json().data.id as string },
      });
      // Whitespace is not a promotion, and must not be recorded as one.
      assert.equal(request.promoCode, null);
    });

    it('still books normally with no code at all', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `NOPRM_${randomUUID().slice(0, 6)}` });
      const customer = await customerWithProfile('+919876730122');

      const { requestId } = await requestRide(customer, vehicleTypeId);
      const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.equal(request.promoCode, null);
    });
  });

  /// `dropLat`/`dropLng` were `.optional()` on both schemas while everything
  /// behind them required a drop, so a body the schema advertised as valid died
  /// on a bare `Error` inside pricing and came back as 500 INTERNAL — the server
  /// blaming itself for the client following its own contract.
  describe('a ride needs somewhere to go (H-4)', () => {
    it('refuses a quote with no drop, as a validation error and not a 500', async () => {
      const customer = await customerWithProfile('+919876730110');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/quote',
        headers: customer.authHeader,
        payload: { pickupLat: 12.9716, pickupLng: 77.5946 },
      });

      assert.equal(response.statusCode, 400, response.payload);
      assert.equal(response.json().error.code, 'VALIDATION');
      // The point of a 400 over a 500 is that it says which fields are wrong.
      const paths = (response.json().error.details as { path: string[] }[]).map((issue) =>
        issue.path.join('.'),
      );
      assert.deepEqual(paths.sort(), ['dropLat', 'dropLng']);
    });

    it('refuses a booking with no drop, and writes nothing', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `NODROP_${randomUUID().slice(0, 6)}` });
      const customer = await customerWithProfile('+919876730111');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/requests',
        headers: customer.authHeader,
        payload: { vehicleTypeId, pickupLat: 12.9716, pickupLng: 77.5946 },
      });

      assert.equal(response.statusCode, 400, response.payload);
      assert.equal(response.json().error.code, 'VALIDATION');
      assert.equal(await db().client.rideRequest.count(), 0);
    });

    it('refuses half a drop, so a dropped field cannot be read as no destination', async () => {
      const customer = await customerWithProfile('+919876730112');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/quote',
        headers: customer.authHeader,
        payload: { pickupLat: 12.9716, pickupLng: 77.5946, dropLat: 12.9352 },
      });

      assert.equal(response.statusCode, 400, response.payload);
      const paths = (response.json().error.details as { path: string[] }[]).map((issue) =>
        issue.path.join('.'),
      );
      assert.deepEqual(paths, ['dropLng']);
    });

    it('still quotes and books a trip that has a drop', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `DROP_${randomUUID().slice(0, 6)}` });
      const customer = await customerWithProfile('+919876730113');

      const quoted = await app.inject({
        method: 'POST',
        url: '/api/v1/rides/quote',
        headers: customer.authHeader,
        payload: { vehicleTypeId, ...TRIP },
      });
      assert.equal(quoted.statusCode, 200, quoted.payload);
      assert.ok(quoted.json().data.estimatedDistanceKm > 0);

      const { requestId } = await requestRide(customer, vehicleTypeId);
      const request = await db().client.rideRequest.findUniqueOrThrow({ where: { id: requestId } });
      assert.ok(request.dropLat !== null && request.dropLng !== null);
    });
  });
});
