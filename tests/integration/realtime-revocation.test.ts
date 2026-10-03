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
import type { PublishInput } from '../../src/core/events/types.js';
import { container } from '../../src/core/di.js';
import type { EventPublisher } from '../../src/core/events/EventPublisher.js';
import type { RedisService } from '../../src/core/cache/RedisService.js';
import { PAYMENT_EVENT_CATALOG, paymentEvent } from '../../src/modules/payments/events/catalog.js';
import { DRIVER_EVENT_CATALOG, driverEvent } from '../../src/modules/drivers/events/catalog.js';
import type { DriverService } from '../../src/modules/drivers/services/driver.service.js';
import type { LocationStreamService } from '../../src/modules/realtime/location-stream.service.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const OPS = 'dashboard:ops';
const FINANCE = 'dashboard:finance';
const CENTRE = { latitude: 12.9716, longitude: 77.5946 };

interface Ack {
  ok: boolean;
  rooms?: string[];
  persisted?: boolean;
  error?: { code: string };
}
interface Ready {
  userId: string;
  driverId: string | null;
  roles: string[];
  rooms: string[];
}
interface Staff extends LoggedInUser {
  email: string;
  password: string;
}
interface Driver extends LoggedInUser {
  driverId: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isUnauthenticated = (err: unknown) =>
  (err as { code?: string }).code === 'SOCKET_UNAUTHENTICATED';
const sidOf = (token: string): string =>
  (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sid: string }).sid;

/// P0-2: an open socket keeps no authority its token, session, roles,
/// permissions or driver identity no longer carry. Real sockets, real admin
/// endpoints, the real outbox relay driven by hand.
describe('realtime revocation lifecycle (integration)', () => {
  let server: ListeningApp;
  let unsubscribe: Unsubscribe;
  const openSockets: ClientSocket[] = [];
  const ended = new WeakMap<ClientSocket, Promise<string>>();
  const ready = new WeakMap<ClientSocket, Ready>();
  let seq = 0;
  const nextPhone = () => `+91962${String(Date.now()).slice(-5)}${String(seq++).padStart(2, '0')}`;

  before(async () => {
    // Seeds roles first, so the suite also runs on a freshly migrated database.
    await resetState();
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

  // ------------------------------------------------------------ identities

  async function adminLogin(email: string, password: string) {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    return {
      accessToken: body.accessToken as string,
      refreshToken: body.refreshToken as string,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };
  }

  /// Staff signed in the way the admin panel signs in (email + password).
  async function staff(role: string): Promise<Staff> {
    const seed = await loginAs(server.app, nextPhone());
    await grantRole(seed.userId, role);
    const email = `rt-${randomUUID().slice(0, 8)}@zaroorat.test`;
    const password = 'Staff@12345';
    await db().client.user.update({
      where: { id: seed.userId },
      data: { email, passwordHash: hashPassword(password), isEmailVerified: true },
    });
    return { ...(await adminLogin(email, password)), userId: seed.userId, email, password };
  }

  async function onlineDriver(): Promise<Driver> {
    const phone = nextPhone();
    const seed = await loginAs(server.app, phone);
    await grantRole(seed.userId, 'driver');
    // The token must carry the driver role, so mint it after the grant.
    const user = await loginAs(server.app, phone);
    const driverId = await makeDriver(user.userId, { verified: true });
    const vehicleTypeId = await makeVehicleType({ code: `RV_${randomUUID().slice(0, 6)}` });
    await makeAssignedVehicle(driverId, { vehicleTypeId });
    for (const [url, payload] of [
      ['/api/v1/drivers/status/online', {}],
      ['/api/v1/drivers/location', CENTRE],
    ] as const) {
      const res = await server.app.inject({
        method: 'POST',
        url,
        headers: user.authHeader,
        payload,
      });
      assert.ok(res.statusCode < 300, `${url}: ${res.payload}`);
    }
    await drainOutbox();
    return { ...user, driverId };
  }

  const api = (
    actor: Staff,
    method: 'GET' | 'PUT' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) =>
    server.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: actor.authHeader,
      ...(payload ? { payload } : {}),
    });

  async function setRolePermissions(
    actor: Staff,
    slug: string,
    edit: (codes: string[]) => string[],
  ) {
    const roles = (await api(actor, 'GET', '/admin/rbac/roles')).json().data as Array<{
      slug: string;
      permissionCodes: string[];
    }>;
    const role = roles.find((r) => r.slug === slug);
    assert.ok(role, `role ${slug} is listed`);
    const res = await api(actor, 'PUT', `/admin/rbac/roles/${slug}/permissions`, {
      permissionCodes: edit(role.permissionCodes),
    });
    assert.equal(res.statusCode, 200, res.payload);
  }

  async function customRole(actor: Staff, permissionCodes: string[]): Promise<string> {
    const res = await api(actor, 'POST', '/admin/rbac/roles', {
      name: `Viewers ${randomUUID().slice(0, 6)}`,
      permissionCodes,
    });
    assert.equal(res.statusCode, 201, res.payload);
    return res.json().data.slug as string;
  }

  // ------------------------------------------------------------ sockets

  function connect(token: string): Promise<ClientSocket> {
    const socket = connectClient(server.url, {
      path: realtimeConfig.path,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    openSockets.push(socket);
    ended.set(socket, new Promise((resolve) => socket.once('disconnect', resolve)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not settle')), 5_000);
      socket.once('connection.ready', (payload: Ready) => {
        clearTimeout(timer);
        ready.set(socket, payload);
        resolve(socket);
      });
      socket.once('connect_error', (err: Error & { data?: { code?: string } }) => {
        clearTimeout(timer);
        reject(Object.assign(err, { code: err.data?.code }));
      });
    });
  }

  function command(socket: ClientSocket, event: string, payload: unknown = {}): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 5_000);
      socket.emit(event, payload, (res: Ack) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  async function endedByServer(socket: ClientSocket): Promise<void> {
    const reason = await Promise.race([ended.get(socket)!, sleep(3_000).then(() => 'still open')]);
    assert.equal(reason, 'io server disconnect', 'the server must end this socket');
  }

  async function stillOpen(socket: ClientSocket): Promise<void> {
    const reason = await Promise.race([ended.get(socket)!, sleep(400).then(() => null)]);
    assert.equal(reason, null, 'this socket must stay open');
  }

  /// Every event a socket hears from now on.
  function record(socket: ClientSocket): string[] {
    const heard: string[] = [];
    socket.onAny((event: string) => heard.push(event));
    return heard;
  }

  async function relay(input: PublishInput): Promise<void> {
    const publisher = container.resolve<EventPublisher>('eventPublisher');
    await db().client.$transaction(async (tx) => publisher.publish(input, tx as never));
    await drainOutbox();
    await sleep(300);
  }
  const financeHint = () =>
    relay(
      paymentEvent(PAYMENT_EVENT_CATALOG.RIDE_COLLECTED, randomUUID(), {
        rideId: randomUUID(),
        amount: 250,
      }),
    );
  const opsHint = () => {
    const driverId = randomUUID();
    return relay(
      driverEvent(DRIVER_EVENT_CATALOG.STATUS_CHANGED, driverId, { driverId, status: 'ONLINE' }),
    );
  };

  async function storedLatitude(driverId: string): Promise<number> {
    const row = await db().client.driverLocation.findUniqueOrThrow({ where: { driverId } });
    return Number(row.latitude);
  }

  // ------------------------------------------------------------ roles

  describe('role revocation', () => {
    it('A: demoting an admin ends their open sockets, active or idle, without a token refresh', async () => {
      const actor = await staff('system_admin');
      const target = await staff('admin');
      const idle = await connect(target.accessToken);
      const active = await connect(target.accessToken);
      assert.deepEqual(await command(idle, 'dashboard.subscribe'), {
        ok: true,
        rooms: [OPS, FINANCE],
      });
      const heard = record(idle);

      const res = await api(actor, 'PATCH', `/admin/users/${target.userId}`, { role: 'support' });
      assert.equal(res.statusCode, 200, res.payload);

      // Active: the epoch moved with the commit, so the next command is refused
      // and ends the socket — before any event is relayed.
      const refused = await command(active, 'dashboard.subscribe');
      assert.equal(refused.ok, false);
      assert.equal(refused.error?.code, 'SOCKET_UNAUTHENTICATED');
      await endedByServer(active);

      // Idle: account.role.* reaches the revocation consumer, which ends it.
      await stillOpen(idle);
      await drainOutbox();
      await endedByServer(idle);
      // L: revocation adds nothing to the wire but the disconnect itself.
      assert.deepEqual(heard, []);
      // I: the old credentials cannot reopen it.
      await assert.rejects(() => connect(target.accessToken), isUnauthenticated);
    });

    it('B: a demoted system_admin keeps no privileged room, although the token named system_admin', async () => {
      const actor = await staff('system_admin');
      const target = await staff('system_admin');
      const idle = await connect(target.accessToken);
      const active = await connect(target.accessToken);
      assert.deepEqual(await command(idle, 'dashboard.subscribe'), {
        ok: true,
        rooms: [OPS, FINANCE],
      });
      const heard = record(idle);

      const res = await api(actor, 'PATCH', `/admin/users/${target.userId}`, { role: 'support' });
      assert.equal(res.statusCode, 200, res.payload);

      // The token still says system_admin; the epoch says it is retired.
      const refused = await command(active, 'dashboard.subscribe');
      assert.equal(refused.error?.code, 'SOCKET_UNAUTHENTICATED');
      await endedByServer(active);

      await drainOutbox();
      await endedByServer(idle);
      await financeHint();
      assert.deepEqual(heard, [], 'no finance or ops hint after the demotion');
      await assert.rejects(() => connect(target.accessToken), isUnauthenticated);
    });

    it('I+J: stale credentials cannot reconnect; fresh ones get only what the current role grants', async () => {
      const actor = await staff('system_admin');
      const target = await staff('admin');
      const socket = await connect(target.accessToken);
      await command(socket, 'dashboard.subscribe');

      await api(actor, 'PATCH', `/admin/users/${target.userId}`, { role: 'support' });
      await drainOutbox();
      await endedByServer(socket);
      await assert.rejects(() => connect(target.accessToken), isUnauthenticated);

      const fresh = await adminLogin(target.email, target.password);
      const again = await connect(fresh.accessToken);
      assert.ok(ready.get(again)!.roles.includes('support'));
      assert.ok(!ready.get(again)!.roles.includes('admin'));
      // No membership carried over: rooms are decided again from the database.
      const heard = record(again);
      await financeHint();
      assert.deepEqual(heard, [], 'a new socket is in no dashboard room until it subscribes');
      assert.deepEqual(await command(again, 'dashboard.subscribe'), { ok: true, rooms: [OPS] });
    });
  });

  // ------------------------------------------------------------ sessions

  describe('session revocation', () => {
    it('C: revoking one session ends that session’s sockets and no other; logout ends the rest', async () => {
      const phone = nextPhone();
      const a = await loginAs(server.app, phone);
      const b = await loginAs(server.app, phone);
      const onA = await connect(a.accessToken);
      const onB = await connect(b.accessToken);
      assert.ok(
        !ready.get(onA)!.rooms.some((name) => name.startsWith('session:')),
        'L: the session room is never reported to the client',
      );

      const revoked = await server.app.inject({
        method: 'DELETE',
        url: `/api/v1/auth/me/sessions/${sidOf(a.accessToken)}`,
        headers: b.authHeader,
      });
      assert.ok(revoked.statusCode < 300, revoked.payload);
      await drainOutbox();
      await endedByServer(onA);
      await stillOpen(onB);
      assert.equal((await command(onB, 'ride.leave', { rideId: randomUUID() })).ok, true);
      await assert.rejects(() => connect(a.accessToken), isUnauthenticated);

      const out = await server.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: b.authHeader,
        payload: { refreshToken: b.refreshToken },
      });
      assert.ok(out.statusCode < 300, out.payload);
      await drainOutbox();
      await endedByServer(onB);
    });

    it('D: logoutAll ends every socket of every session', async () => {
      const phone = nextPhone();
      const a = await loginAs(server.app, phone);
      const b = await loginAs(server.app, phone);
      const a1 = await connect(a.accessToken);
      const a2 = await connect(a.accessToken);
      const b1 = await connect(b.accessToken);

      const res = await server.app.inject({
        method: 'DELETE',
        url: '/api/v1/auth/me/sessions',
        headers: a.authHeader,
      });
      assert.ok(res.statusCode < 300, res.payload);

      // logoutAll bumps the epoch: a command is refused before any relay.
      const refused = await command(b1, 'ride.leave', { rideId: randomUUID() });
      assert.equal(refused.error?.code, 'SOCKET_UNAUTHENTICATED');
      await endedByServer(b1);

      await drainOutbox();
      await endedByServer(a1);
      await endedByServer(a2);
      // Idempotent: relaying again (nothing new) and revoking an already-closed
      // session's room are both harmless.
      await drainOutbox();
    });
  });

  // ------------------------------------------------------------ permissions

  describe('permission removal', () => {
    it('E: removing finance:read takes dashboard:finance away from an open socket', async () => {
      const actor = await staff('system_admin');
      const finance = await staff('finance');
      const socket = await connect(finance.accessToken);
      assert.deepEqual(await command(socket, 'dashboard.subscribe'), {
        ok: true,
        rooms: [FINANCE],
      });
      const heard = record(socket);
      await financeHint();
      assert.deepEqual(heard, ['dashboard.financials.changed'], 'control: the room works');
      heard.length = 0;

      await setRolePermissions(actor, 'finance', (codes) =>
        codes.filter((c) => c !== 'finance:read'),
      );
      await drainOutbox();
      await financeHint();
      assert.deepEqual(heard, [], 'no financial hint once finance:read is gone');

      // Permissions are not in the token: the session is still valid, the room is not.
      await stillOpen(socket);
      assert.equal(
        (await command(socket, 'dashboard.subscribe')).error?.code,
        'ROOM_ACCESS_DENIED',
      );
    });

    it('F: removing operations:read takes dashboard:ops away, and only from the role that lost it', async () => {
      const actor = await staff('system_admin');
      const support = await staff('support');
      const admin = await staff('admin');
      const supportSocket = await connect(support.accessToken);
      const adminSocket = await connect(admin.accessToken);
      assert.deepEqual(await command(supportSocket, 'dashboard.subscribe'), {
        ok: true,
        rooms: [OPS],
      });
      await command(adminSocket, 'dashboard.subscribe');
      const supportHeard = record(supportSocket);
      const adminHeard = record(adminSocket);
      await opsHint();
      assert.deepEqual(
        supportHeard,
        ['dashboard.driver.status_changed'],
        'control: the room works',
      );
      supportHeard.length = 0;
      adminHeard.length = 0;

      await setRolePermissions(actor, 'support', (codes) =>
        codes.filter((c) => c !== 'operations:read'),
      );
      await drainOutbox();
      await opsHint();
      assert.deepEqual(supportHeard, [], 'no ops hint once operations:read is gone');
      assert.deepEqual(adminHeard, ['dashboard.driver.status_changed'], 'admin is unaffected');
      await financeHint();
      assert.deepEqual(adminHeard.at(-1), 'dashboard.financials.changed');
    });

    it('G: a custom role loses the room its permission granted', async () => {
      const actor = await staff('system_admin');
      const slug = await customRole(actor, ['operations:read']);
      const viewer = await staff(slug);
      const socket = await connect(viewer.accessToken);
      assert.deepEqual(await command(socket, 'dashboard.subscribe'), { ok: true, rooms: [OPS] });
      const heard = record(socket);
      await opsHint();
      assert.equal(heard.length, 1, 'control: the room works');
      heard.length = 0;

      await setRolePermissions(actor, slug, () => ['audit:read']);
      await drainOutbox();
      await opsHint();
      assert.deepEqual(heard, []);
      assert.equal(
        (await command(socket, 'dashboard.subscribe')).error?.code,
        'ROOM_ACCESS_DENIED',
      );
    });
  });

  // ------------------------------------------------------------ dashboard rooms

  it('K: rooms follow current database permissions for every kind of principal', async () => {
    const actor = await staff('system_admin');
    const financeOnly = await customRole(actor, ['finance:read']);
    const expectRooms = async (token: string, rooms: string[] | null) => {
      const res = await command(await connect(token), 'dashboard.subscribe');
      if (rooms) assert.deepEqual(res, { ok: true, rooms });
      else assert.equal(res.error?.code, 'ROOM_ACCESS_DENIED');
    };
    await expectRooms((await staff('support')).accessToken, [OPS]);
    await expectRooms((await staff('finance')).accessToken, [FINANCE]);
    await expectRooms((await staff('admin')).accessToken, [OPS, FINANCE]);
    await expectRooms(actor.accessToken, [OPS, FINANCE]);
    await expectRooms((await staff(financeOnly)).accessToken, [FINANCE]);
    await expectRooms((await loginAs(server.app, nextPhone())).accessToken, null);
    await expectRooms((await onlineDriver()).accessToken, null);
  });

  // ------------------------------------------------------------ drivers

  describe('driver location', () => {
    const near = { latitude: CENTRE.latitude + 0.00002, longitude: CENTRE.longitude + 0.00002 };
    const moved = { latitude: near.latitude + 0.00002, longitude: near.longitude };
    /// Clears the per-driver throttle, so a frame that got through would be persisted.
    const forgetThrottle = (driverId: string) =>
      container.resolve<LocationStreamService>('locationStreamService').forget(driverId);

    it('H: a driver suspended by an operator cannot move driver_locations from the open socket', async () => {
      const actor = await staff('system_admin');
      const driver = await onlineDriver();
      const socket = await connect(driver.accessToken);
      const accepted = await command(socket, 'driver.location.update', near);
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      assert.equal(accepted.persisted, true);
      assert.equal(await storedLatitude(driver.driverId), near.latitude);

      const res = await api(actor, 'POST', `/admin/drivers/${driver.driverId}/suspend`, {});
      assert.equal(res.statusCode, 200, res.payload);

      forgetThrottle(driver.driverId);
      const refused = await command(socket, 'driver.location.update', moved);
      assert.equal(refused.ok, false);
      assert.equal(refused.error?.code, 'SOCKET_UNAUTHENTICATED');
      await endedByServer(socket);
      assert.equal(
        await storedLatitude(driver.driverId),
        near.latitude,
        'the location did not move',
      );
      await assert.rejects(() => connect(driver.accessToken), isUnauthenticated);
    });

    it('H: a suspension that leaves the session alone still ends the driver identity', async () => {
      const driver = await onlineDriver();
      const idle = await connect(driver.accessToken);
      const active = await connect(driver.accessToken);
      assert.equal((await command(active, 'driver.location.update', near)).ok, true);

      // The drivers-module path: driver.suspended, no session revocation, no epoch bump.
      await container
        .resolve<DriverService>('driverService')
        .status.setSuspended(driver.driverId, true);

      forgetThrottle(driver.driverId);
      const refused = await command(active, 'driver.location.update', moved);
      assert.equal(refused.error?.code, 'SOCKET_UNAUTHENTICATED');
      await endedByServer(active);
      assert.equal(await storedLatitude(driver.driverId), near.latitude);

      await drainOutbox();
      await endedByServer(idle);

      // The session is still valid, so the user may reconnect — with no driver identity.
      const again = await connect(driver.accessToken);
      assert.equal(ready.get(again)!.driverId, null);
      assert.deepEqual(ready.get(again)!.rooms, [`user:${driver.userId}`]);
      forgetThrottle(driver.driverId);
      const denied = await command(again, 'driver.location.update', moved);
      assert.equal(denied.error?.code, 'SOCKET_FORBIDDEN');
      assert.equal(await storedLatitude(driver.driverId), near.latitude);
    });
  });

  // ------------------------------------------------------------ races and failure

  it('race: a command during an uncommitted role change runs on the old grant; none runs after commit', async () => {
    const actor = await staff('system_admin');
    const target = await staff('admin');
    const idle = await connect(target.accessToken);
    const active = await connect(target.accessToken);
    await command(idle, 'dashboard.subscribe');

    // Hold the target's profile row, so the role change blocks inside its transaction.
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db().client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM user_profiles WHERE user_id = ${target.userId}::uuid FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    let committed = false;
    const change = api(actor, 'PATCH', `/admin/users/${target.userId}`, {
      firstName: 'Raced',
      role: 'support',
    }).then((res) => {
      committed = true;
      return res;
    });
    await sleep(300);
    assert.equal(committed, false, 'the role change is held mid-transaction');

    // Nothing has committed: the old grant is still the truth, and is honoured.
    assert.deepEqual(await command(active, 'dashboard.subscribe'), {
      ok: true,
      rooms: [OPS, FINANCE],
    });

    release();
    await holder;
    assert.equal((await change).statusCode, 200);

    // Committed: no command runs on the old grant, and idle membership ends on relay.
    assert.equal(
      (await command(active, 'dashboard.subscribe')).error?.code,
      'SOCKET_UNAUTHENTICATED',
    );
    await endedByServer(active);
    await drainOutbox();
    await endedByServer(idle);
  });

  it('fail closed: an unreadable revocation store refuses every command but does not end the socket', async () => {
    const driver = await onlineDriver();
    const socket = await connect(driver.accessToken);
    const epoch = container.resolve<RedisService>('redisService').epoch as unknown as {
      get: (userId: string) => Promise<number>;
    };
    epoch.get = () => Promise.reject(new Error('redis down'));
    try {
      const refused = await command(socket, 'driver.location.update', {
        latitude: CENTRE.latitude + 0.00002,
        longitude: CENTRE.longitude,
      });
      assert.equal(refused.error?.code, 'SERVICE_UNAVAILABLE');
      assert.equal(await storedLatitude(driver.driverId), CENTRE.latitude, 'nothing persisted');
    } finally {
      delete (epoch as { get?: unknown }).get;
    }
    await stillOpen(socket);
    const recovered = await command(socket, 'driver.location.update', {
      latitude: CENTRE.latitude + 0.00002,
      longitude: CENTRE.longitude,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
  });
});
