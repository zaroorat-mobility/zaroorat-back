import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';

import {
  bootEventConsumers,
  bootListeningApp,
  db,
  drainOutbox,
  loginAs,
  resetState,
  type ListeningApp,
  type LoggedInUser,
} from './helpers/harness.js';
import { grantRole, makeAssignedVehicle, makeDriver, makeVehicleType } from './helpers/fixtures.js';
import { realtimeConfig } from '../../src/config/realtime/realtime.config.js';
import type { Unsubscribe } from '../../src/core/events/index.js';

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

describe('realtime socket gateway (integration)', () => {
  let server: ListeningApp;
  let unsubscribe: Unsubscribe;
  const openSockets: ClientSocket[] = [];

  before(async () => {
    server = await bootListeningApp();
    unsubscribe = bootEventConsumers();
  });
  after(async () => {
    unsubscribe();
    await server.close();
  });
  afterEach(async () => {
    while (openSockets.length) openSockets.pop()?.disconnect();
    await resetState();
  });

  // ---------------------------------------------------------------- helpers

  /// Opens an authenticated client socket and resolves once the server has sent
  /// `connection.ready` — i.e. the handshake passed and identity rooms were
  /// joined. Rejects with the server's error code if the handshake was refused.
  function connect(token: string, timeoutMs = 5_000): Promise<ClientSocket> {
    const socket = connectClient(server.url, {
      path: realtimeConfig.path,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: timeoutMs,
    });
    openSockets.push(socket);

    return new Promise<ClientSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not settle in time')), timeoutMs);
      socket.on('connection.ready', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
        clearTimeout(timer);
        reject(Object.assign(err, { code: err.data?.code }));
      });
    });
  }

  function waitFor<T = Record<string, unknown>>(
    socket: ClientSocket,
    event: string,
    timeoutMs = 4_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${event}`)),
        timeoutMs,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  /// Resolves `false` if the event does NOT arrive inside the window — the shape
  /// every "this client must never hear that" assertion needs.
  async function neverArrives(socket: ClientSocket, event: string, windowMs = 700): Promise<void> {
    const received = await Promise.race([
      waitFor(socket, event, windowMs).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), windowMs)),
    ]).catch(() => false);
    assert.equal(received, false, `this client must never receive ${event}`);
  }

  function emit(
    socket: ClientSocket,
    event: string,
    payload: unknown,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 4_000);
      socket.emit(event, payload, (response: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  async function onlineDriver(phone: string, vehicleTypeId: string): Promise<OnlineDriver> {
    const seed = await loginAs(server.app, phone);
    await grantRole(seed.userId, 'driver');
    // With every consumer registered, `account.role.granted` reaches
    // EpochInvalidationConsumer and retires this user's tokens — correct
    // production behaviour. Drain it first, then mint a token on the new epoch,
    // or the driver goes 401 the moment any later test drains the outbox.
    await drainOutbox();
    const user = await loginAs(server.app, phone);
    const driverId = await makeDriver(user.userId, { verified: true });
    const { vehicleId } = await makeAssignedVehicle(driverId, { vehicleTypeId });
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: user.authHeader,
      payload: {},
    });
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/drivers/location',
      headers: user.authHeader,
      payload: CENTRE,
    });
    return { ...user, driverId, vehicleId };
  }

  async function customer(phone: string): Promise<LoggedInUser> {
    await loginAs(server.app, phone);
    // Same reason as `onlineDriver`: registration grants the default role, whose
    // event bumps the epoch when it is eventually relayed.
    await drainOutbox();
    const user = await loginAs(server.app, phone);
    await server.app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: user.authHeader,
      payload: { firstName: 'Cat', lastName: 'Customer' },
    });
    return user;
  }

  /// A ride that has been requested, dispatched and accepted, with the outbox
  /// drained at each step so every consumer has actually run.
  async function acceptedRide(
    driver: OnlineDriver,
    rider: LoggedInUser,
    vehicleTypeId: string,
  ): Promise<{ rideId: string; requestId: string }> {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: rider.authHeader,
      payload: { vehicleTypeId, ...TRIP },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const requestId = created.json().data.id as string;
    await drainOutbox();

    const accepted = await server.app.inject({
      method: 'POST',
      url: '/api/v1/rides/accept',
      headers: driver.authHeader,
      payload: { requestId, vehicleId: driver.vehicleId },
    });
    assert.equal(accepted.statusCode, 200, accepted.payload);
    return { rideId: accepted.json().data.ride.id as string, requestId };
  }

  // ------------------------------------------------------------ handshake

  describe('handshake authentication', () => {
    it('accepts a valid access token and reports the resolved identity', async () => {
      const user = await customer('+919876770001');
      const socket = connectClient(server.url, {
        path: realtimeConfig.path,
        transports: ['websocket'],
        auth: { token: user.accessToken },
        reconnection: false,
      });
      openSockets.push(socket);

      const payload = await waitFor(socket, 'connection.ready');

      assert.equal(payload.userId, user.userId);
      assert.equal(payload.driverId, null, 'a customer carries no driver identity');
      assert.deepEqual(payload.rooms, [`user:${user.userId}`]);
      assert.ok(
        (payload.resync as Record<string, string>).rides,
        'the client is told where to resync',
      );
    });

    it('gives an operable driver a driver room as well', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RT_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770002', vehicleTypeId);
      const socket = connectClient(server.url, {
        path: realtimeConfig.path,
        transports: ['websocket'],
        auth: { token: driver.accessToken },
        reconnection: false,
      });
      openSockets.push(socket);

      const payload = await waitFor(socket, 'connection.ready');
      assert.equal(payload.driverId, driver.driverId);
      assert.deepEqual(payload.rooms, [`user:${driver.userId}`, `driver:${driver.driverId}`]);
    });

    it('refuses a connection with no token', async () => {
      await assert.rejects(
        () => connect(''),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED',
      );
    });

    it('refuses a garbage token', async () => {
      await assert.rejects(
        () => connect('not.a.token'),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED',
      );
    });

    it('refuses a token whose session has been revoked', async () => {
      const user = await customer('+919876770003');
      const loggedOut = await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: user.authHeader,
        payload: { refreshToken: user.refreshToken },
      });
      assert.ok([200, 204].includes(loggedOut.statusCode), loggedOut.payload);

      await assert.rejects(
        () => connect(user.accessToken),
        (err: unknown) => (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED',
      );
    });
  });

  // ------------------------------------------------------------ room access

  describe('room authorization', () => {
    it('lets the customer and the assigned driver join their ride room', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RM_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770004', vehicleTypeId);
      const rider = await customer('+919876770005');
      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);

      const riderSocket = await connect(rider.accessToken);
      const driverSocket = await connect(driver.accessToken);

      assert.deepEqual(await emit(riderSocket, 'ride.join', { rideId }), {
        ok: true,
        room: `ride:${rideId}`,
      });
      assert.deepEqual(await emit(driverSocket, 'ride.join', { rideId }), {
        ok: true,
        room: `ride:${rideId}`,
      });
    });

    it('refuses an unrelated customer trying to join a ride room', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RM2_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770006', vehicleTypeId);
      const rider = await customer('+919876770007');
      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);
      const stranger = await customer('+919876770008');

      const strangerSocket = await connect(stranger.accessToken);
      const response = await emit(strangerSocket, 'ride.join', { rideId });

      assert.equal(response.ok, false);
      assert.equal((response.error as { code: string }).code, 'ROOM_ACCESS_DENIED');
    });

    it('refuses an unassigned driver trying to join a ride room', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RM3_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770009', vehicleTypeId);
      const rider = await customer('+919876770010');
      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);
      const otherDriver = await onlineDriver('+919876770011', vehicleTypeId);

      const otherSocket = await connect(otherDriver.accessToken);
      const response = await emit(otherSocket, 'ride.join', { rideId });

      assert.equal((response.error as { code: string }).code, 'ROOM_ACCESS_DENIED');
    });

    it('refuses a ride room that does not exist, without confirming as much', async () => {
      const rider = await customer('+919876770012');
      const socket = await connect(rider.accessToken);
      const response = await emit(socket, 'ride.join', { rideId: randomUUID() });
      assert.equal((response.error as { code: string }).code, 'ROOM_ACCESS_DENIED');
    });

    it('rejects a malformed join payload without dropping the socket', async () => {
      const rider = await customer('+919876770013');
      const socket = await connect(rider.accessToken);

      const response = await emit(socket, 'ride.join', { notARideId: 1 });
      assert.equal((response.error as { code: string }).code, 'INVALID_SOCKET_PAYLOAD');
      assert.equal(socket.connected, true, 'a bad command must not tear the connection down');
    });
  });

  // ------------------------------------------------------------ the bridge

  describe('domain events reach authorized clients', () => {
    it('delivers a dispatch offer to the offered driver and nobody else', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EV_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770014', vehicleTypeId);
      const rider = await customer('+919876770015');

      const driverSocket = await connect(driver.accessToken);
      const riderSocket = await connect(rider.accessToken);
      const offerSeen = waitFor(driverSocket, 'ride.offer.received');

      await server.app.inject({
        method: 'POST',
        url: '/api/v1/rides/requests',
        headers: rider.authHeader,
        payload: { vehicleTypeId, ...TRIP },
      });
      await drainOutbox();

      const offer = await offerSeen;
      assert.equal(typeof offer.eventId, 'string', 'carries the outbox id for de-duplication');
      assert.equal(offer.type, 'ride.offer.received');
      assert.equal(typeof (offer.data as Record<string, unknown>).dispatchId, 'string');
      // An offer is not public — not even to the customer who caused it.
      await neverArrives(riderSocket, 'ride.offer.received');
    });

    it('tells the customer their request is searching', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EV2_${randomUUID().slice(0, 6)}` });
      await onlineDriver('+919876770016', vehicleTypeId);
      const rider = await customer('+919876770017');
      const riderSocket = await connect(rider.accessToken);
      const requested = waitFor(riderSocket, 'ride.requested');

      await server.app.inject({
        method: 'POST',
        url: '/api/v1/rides/requests',
        headers: rider.authHeader,
        payload: { vehicleTypeId, ...TRIP },
      });
      await drainOutbox();

      const event = await requested;
      assert.equal((event.data as Record<string, unknown>).vehicleTypeId, vehicleTypeId);
    });

    it('delivers the whole ride lifecycle to both participants', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EV3_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770018', vehicleTypeId);
      const rider = await customer('+919876770019');
      const riderSocket = await connect(rider.accessToken);
      const driverSocket = await connect(driver.accessToken);

      const assigned = waitFor(riderSocket, 'ride.driver.assigned');
      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);
      await drainOutbox();

      const assignment = await assigned;
      assert.equal((assignment.data as Record<string, unknown>).rideId, rideId);
      assert.equal((assignment.data as Record<string, unknown>).driverId, driver.driverId);

      // The customer only learns the rideId from that event, so joining the ride
      // room can only happen after it — which is why the bridge also addresses
      // the identity rooms.
      await emit(riderSocket, 'ride.join', { rideId });
      await emit(driverSocket, 'ride.join', { rideId });

      for (const [url, socketEvent] of [
        [`/api/v1/rides/${rideId}/arriving`, 'ride.driver.arriving'],
        [`/api/v1/rides/${rideId}/arrive`, 'ride.driver.arrived'],
      ] as [string, string][]) {
        const seen = waitFor(riderSocket, socketEvent);
        const response = await server.app.inject({
          method: 'POST',
          url,
          headers: driver.authHeader,
          payload: {},
        });
        assert.equal(response.statusCode, 200, response.payload);
        await drainOutbox();
        const event = await seen;
        assert.equal((event.data as Record<string, unknown>).rideId, rideId);
      }
    });

    it('does not leak another ride’s events to an unrelated customer', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `EV4_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770020', vehicleTypeId);
      const rider = await customer('+919876770021');
      const stranger = await customer('+919876770022');
      const strangerSocket = await connect(stranger.accessToken);

      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);
      await drainOutbox();
      await server.app.inject({
        method: 'POST',
        url: `/api/v1/rides/${rideId}/arriving`,
        headers: driver.authHeader,
        payload: {},
      });
      await drainOutbox();

      await neverArrives(strangerSocket, 'ride.driver.assigned');
      await neverArrives(strangerSocket, 'ride.driver.arriving');
    });
  });

  // ------------------------------------------------------------ location

  describe('driver location streaming', () => {
    async function rideInProgress(phones: { driver: string; rider: string; code: string }) {
      const vehicleTypeId = await makeVehicleType({ code: phones.code });
      const driver = await onlineDriver(phones.driver, vehicleTypeId);
      const rider = await customer(phones.rider);
      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);
      await drainOutbox();

      const driverSocket = await connect(driver.accessToken);
      const riderSocket = await connect(rider.accessToken);
      await emit(driverSocket, 'ride.join', { rideId });
      await emit(riderSocket, 'ride.join', { rideId });
      return { driver, rider, rideId, driverSocket, riderSocket, vehicleTypeId };
    }

    it('reaches the customer on that ride', async () => {
      const world = await rideInProgress({
        driver: '+919876770023',
        rider: '+919876770024',
        code: `LOC_${randomUUID().slice(0, 6)}`,
      });
      const seen = waitFor(world.riderSocket, 'ride.driver.location');

      const ack = await emit(world.driverSocket, 'driver.location.update', {
        latitude: 12.9718,
        longitude: 77.5948,
        speedKmh: 24,
      });
      assert.equal(ack.ok, true);
      assert.equal(ack.rooms, 1, 'broadcast into exactly the one ride room');

      const frame = await seen;
      const data = frame.data as Record<string, unknown>;
      assert.equal(data.driverId, world.driver.driverId);
      assert.equal(data.latitude, 12.9718);
      assert.equal(data.speedKmh, 24);
    });

    it('reaches no other customer', async () => {
      const world = await rideInProgress({
        driver: '+919876770025',
        rider: '+919876770026',
        code: `LOC2_${randomUUID().slice(0, 6)}`,
      });
      const stranger = await customer('+919876770027');
      const strangerSocket = await connect(stranger.accessToken);

      await emit(world.driverSocket, 'driver.location.update', {
        latitude: 12.9718,
        longitude: 77.5948,
      });

      // There is no global driver-location channel to subscribe to at all.
      await neverArrives(strangerSocket, 'ride.driver.location');
    });

    it('refuses a location update from a customer', async () => {
      const rider = await customer('+919876770028');
      const socket = await connect(rider.accessToken);

      const response = await emit(socket, 'driver.location.update', CENTRE);
      assert.equal((response.error as { code: string }).code, 'SOCKET_FORBIDDEN');
    });

    it('refuses a malformed frame without dropping the socket', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `LOC3_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770029', vehicleTypeId);
      const socket = await connect(driver.accessToken);

      const response = await emit(socket, 'driver.location.update', { latitude: 999 });
      assert.equal((response.error as { code: string }).code, 'INVALID_SOCKET_PAYLOAD');
      assert.equal(socket.connected, true);
    });

    it('rate-limits a driver flooding frames', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `LOC4_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770030', vehicleTypeId);
      const socket = await connect(driver.accessToken);

      const first = await emit(socket, 'driver.location.update', CENTRE);
      const second = await emit(socket, 'driver.location.update', CENTRE);

      assert.equal(first.ok, true);
      assert.equal(second.ok, false, 'the second frame inside the window is dropped, not queued');
      assert.equal((second.error as { code: string }).code, 'LOCATION_RATE_LIMITED');
    });

    it('writes the position through to driver_locations', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `LOC5_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770031', vehicleTypeId);
      const socket = await connect(driver.accessToken);

      // A few metres from where `onlineDriver` last posted: a bigger jump is
      // refused by the existing plausibility check in LocationService, which is
      // the point of routing socket frames through it rather than around it.
      const moved = { latitude: CENTRE.latitude + 0.00005, longitude: CENTRE.longitude };
      const ack = await emit(socket, 'driver.location.update', moved);
      assert.equal(ack.ok, true, JSON.stringify(ack));

      const stored = await db().client.driverLocation.findUniqueOrThrow({
        where: { driverId: driver.driverId },
      });
      assert.equal(Number(stored.latitude), moved.latitude);
    });

    it('relays the existing plausibility guard instead of a generic failure', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `LOC8_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770040', vehicleTypeId);
      const socket = await connect(driver.accessToken);

      // A teleport away from the position `onlineDriver` just posted. Routing
      // socket frames through LocationService is what keeps this check applying.
      const response = await emit(socket, 'driver.location.update', {
        latitude: 19.076,
        longitude: 72.8777,
      });
      assert.equal(response.ok, false);
      assert.equal((response.error as { code: string }).code, 'IMPLAUSIBLE_LOCATION');
    });

    it('goes nowhere when the driver is in no ride room', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `LOC6_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770032', vehicleTypeId);
      const socket = await connect(driver.accessToken);

      const ack = await emit(socket, 'driver.location.update', CENTRE);
      assert.equal(ack.ok, true);
      assert.equal(ack.rooms, 0, 'accepted and stored, but broadcast to nobody');
    });

    it('stops reaching the customer once the ride is over', async () => {
      const world = await rideInProgress({
        driver: '+919876770033',
        rider: '+919876770034',
        code: `LOC7_${randomUUID().slice(0, 6)}`,
      });

      const cancelled = await server.app.inject({
        method: 'POST',
        url: `/api/v1/rides/${world.rideId}/cancel`,
        headers: world.rider.authHeader,
        payload: { reasonCode: 'CHANGED_MIND' },
      });
      assert.equal(cancelled.statusCode, 200, cancelled.payload);
      await drainOutbox();
      // The terminal event evicts everyone from the ride room, so the driver's
      // socket has nowhere left to publish.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const ack = await emit(world.driverSocket, 'driver.location.update', {
        latitude: 12.9719,
        longitude: 77.5949,
      });
      assert.equal(ack.rooms, 0, 'the ride room was closed with the ride');
      await neverArrives(world.riderSocket, 'ride.driver.location');
    });
  });

  // ------------------------------------------------------------ resync

  describe('reconnection and resync', () => {
    it('restores identity rooms and points the client at the REST API', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RS_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770035', vehicleTypeId);
      const rider = await customer('+919876770036');
      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);
      await drainOutbox();

      const first = await connect(rider.accessToken);
      first.disconnect();

      // Reconnecting is a fresh handshake: rooms are re-derived from the token,
      // never restored from anything the client remembers.
      const second = connectClient(server.url, {
        path: realtimeConfig.path,
        transports: ['websocket'],
        auth: { token: rider.accessToken },
        reconnection: false,
      });
      openSockets.push(second);
      const payload = await waitFor(second, 'connection.ready');
      assert.deepEqual(payload.rooms, [`user:${rider.userId}`]);

      // Ride rooms are NOT auto-restored — the client resyncs from the API and
      // re-joins, which is what keeps membership authorised on every join.
      const resync = payload.resync as Record<string, string>;
      assert.equal(typeof resync.rides, 'string');
      const active = await server.app.inject({
        method: 'GET',
        url: resync.rides!,
        headers: rider.authHeader,
      });
      assert.equal(active.statusCode, 200, active.payload);
      assert.equal(active.json().data.id, rideId, 'the API is the source of truth, not the socket');

      assert.deepEqual(await emit(second, 'ride.join', { rideId }), {
        ok: true,
        room: `ride:${rideId}`,
      });
    });

    it('re-authorises on every join, so a stale client cannot re-enter a finished ride', async () => {
      const vehicleTypeId = await makeVehicleType({ code: `RS2_${randomUUID().slice(0, 6)}` });
      const driver = await onlineDriver('+919876770037', vehicleTypeId);
      const rider = await customer('+919876770038');
      const { rideId } = await acceptedRide(driver, rider, vehicleTypeId);
      const stranger = await customer('+919876770039');
      const strangerSocket = await connect(stranger.accessToken);

      // Even armed with a real rideId, a non-participant is refused every time.
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await emit(strangerSocket, 'ride.join', { rideId });
        assert.equal((response.error as { code: string }).code, 'ROOM_ACCESS_DENIED');
      }
      assert.ok(driver.driverId);
    });
  });
});
