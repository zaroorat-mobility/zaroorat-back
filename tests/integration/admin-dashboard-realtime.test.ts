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
import { container } from '../../src/core/di.js';
import type { EventPublisher } from '../../src/core/events/EventPublisher.js';
import { PAYMENT_EVENT_CATALOG, paymentEvent } from '../../src/modules/payments/events/catalog.js';

interface Ack {
  ok: boolean;
  rooms?: string[];
  error?: { code: string };
}
interface Hint {
  event: string;
  payload: { eventId: string; data: Record<string, unknown> };
}

/// Phase 3: the admin dashboard's realtime channel. Real sockets, real
/// permission lookups, real domain actions relayed through the outbox.
describe('admin dashboard realtime rooms (integration)', () => {
  let server: ListeningApp;
  let unsubscribe: Unsubscribe;
  const openSockets: ClientSocket[] = [];
  let phoneSeq = 0;
  const nextPhone = () =>
    `+91960${String(Date.now()).slice(-5)}${String(phoneSeq++).padStart(2, '0')}`;

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

  async function staff(role?: string): Promise<LoggedInUser> {
    const phone = nextPhone();
    const seed = await loginAs(server.app, phone);
    if (role) await grantRole(seed.userId, role);
    // A role grant bumps the epoch once relayed; mint the token after that.
    await drainOutbox();
    return loginAs(server.app, phone);
  }

  function connect(token: string): Promise<ClientSocket> {
    const socket = connectClient(server.url, {
      path: realtimeConfig.path,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    openSockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connection.ready', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  function command(socket: ClientSocket, event: string): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 4_000);
      socket.emit(event, {}, (res: Ack) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  /// Collects every dashboard hint a socket receives.
  function record(socket: ClientSocket) {
    const seen: Hint[] = [];
    socket.onAny((event: string, payload: Hint['payload']) => {
      if (event.startsWith('dashboard.')) seen.push({ event, payload });
    });
    return seen;
  }

  const settle = () => new Promise((r) => setTimeout(r, 400));

  async function driverGoesOnline(): Promise<string> {
    const phone = nextPhone();
    const seed = await loginAs(server.app, phone);
    await grantRole(seed.userId, 'driver');
    await drainOutbox();
    const user = await loginAs(server.app, phone);
    const driverId = await makeDriver(user.userId, { verified: true });
    const vehicleTypeId = await makeVehicleType({ code: `DR_${randomUUID().slice(0, 6)}` });
    await makeAssignedVehicle(driverId, { vehicleTypeId });
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/drivers/status/online',
      headers: user.authHeader,
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.payload);
    await drainOutbox();
    return driverId;
  }

  it('grants rooms from server-side permissions: support → ops, finance → finance, admin → both', async () => {
    const support = await connect((await staff('support')).accessToken);
    const finance = await connect((await staff('finance')).accessToken);
    const admin = await connect((await staff('admin')).accessToken);
    assert.deepEqual(await command(support, 'dashboard.subscribe'), {
      ok: true,
      rooms: ['dashboard:ops'],
    });
    assert.deepEqual(await command(finance, 'dashboard.subscribe'), {
      ok: true,
      rooms: ['dashboard:finance'],
    });
    assert.deepEqual(await command(admin, 'dashboard.subscribe'), {
      ok: true,
      rooms: ['dashboard:ops', 'dashboard:finance'],
    });
  });

  it('refuses a customer or a user with no dashboard permission', async () => {
    const customer = await connect((await staff()).accessToken);
    const res = await command(customer, 'dashboard.subscribe');
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'ROOM_ACCESS_DENIED');
  });

  it('delivers a driver status hint to operations:read only, with no PII, money or coordinates', async () => {
    const supportSocket = await connect((await staff('support')).accessToken);
    const financeSocket = await connect((await staff('finance')).accessToken);
    const customerSocket = await connect((await staff()).accessToken);
    await command(supportSocket, 'dashboard.subscribe');
    await command(financeSocket, 'dashboard.subscribe');
    await command(customerSocket, 'dashboard.subscribe');
    const supportSeen = record(supportSocket);
    const financeSeen = record(financeSocket);
    const customerSeen = record(customerSocket);

    const driverId = await driverGoesOnline();
    await settle();

    const hint = supportSeen.find((s) => s.event === 'dashboard.driver.status_changed');
    assert.ok(hint, `support must hear the status change; saw ${JSON.stringify(supportSeen)}`);
    assert.deepEqual(hint.payload.data, { driverId, status: 'ONLINE' });
    assert.equal(typeof hint.payload.eventId, 'string');
    assert.deepEqual(financeSeen, [], 'finance:read alone must not receive operational hints');
    assert.deepEqual(customerSeen, [], 'a refused subscriber must receive nothing');
  });

  it('delivers the data-free financial hint to finance:read only', async () => {
    const supportSocket = await connect((await staff('support')).accessToken);
    const financeSocket = await connect((await staff('finance')).accessToken);
    await command(supportSocket, 'dashboard.subscribe');
    await command(financeSocket, 'dashboard.subscribe');
    const supportSeen = record(supportSocket);
    const financeSeen = record(financeSocket);

    const publisher = container.resolve<EventPublisher>('eventPublisher');
    await db().client.$transaction(async (tx) => {
      await publisher.publish(
        paymentEvent(PAYMENT_EVENT_CATALOG.RIDE_COLLECTED, randomUUID(), {
          rideId: randomUUID(),
          amount: 250,
        }),
        tx as never,
      );
    });
    await drainOutbox();
    await settle();

    assert.deepEqual(
      financeSeen.map((s) => [s.event, s.payload.data]),
      [['dashboard.financials.changed', {}]],
    );
    assert.deepEqual(supportSeen, [], 'operations:read alone must not receive financial hints');
  });

  it('stops delivering after unsubscribe', async () => {
    const socket = await connect((await staff('support')).accessToken);
    await command(socket, 'dashboard.subscribe');
    assert.deepEqual(await command(socket, 'dashboard.unsubscribe'), { ok: true });
    const seen = record(socket);
    await driverGoesOnline();
    await settle();
    assert.deepEqual(seen, []);
  });

  it('re-checks the permission on every subscribe, so a revoked role loses the room', async () => {
    const user = await staff('support');
    const socket = await connect(user.accessToken);
    assert.equal((await command(socket, 'dashboard.subscribe')).ok, true);

    // Revoke without relaying the epoch bump, so the socket itself stays open.
    await db().client.userRoleAssignment.updateMany({
      where: { userId: user.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const again = await command(socket, 'dashboard.subscribe');
    assert.equal(again.ok, false);
    assert.equal(again.error?.code, 'ROOM_ACCESS_DENIED');

    const seen = record(socket);
    await driverGoesOnline();
    await settle();
    assert.deepEqual(seen, [], 'membership from the earlier subscribe must not survive');
  });
});
