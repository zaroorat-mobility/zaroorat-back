import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { DeviceService } from '../../../src/modules/auth/services/session/device.service.js';
import { DeviceIdRequiredError } from '../../../src/modules/auth/errors/auth.errors.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import { isUuid } from '../../../src/shared/validation/index.js';

/// PA-6 — the write side of the cross-user token leak, and the atomicity that
/// makes it safe.
///
/// The transaction here is simulated, not real: `transactionManager.execute` is a
/// double that runs the callback and, on a thrown error, discards the writes its
/// participants recorded. That proves the service *puts both writes inside one
/// transaction* and propagates failure — which is the code's contract. It does
/// **not** prove PostgreSQL rolls them back; only a real database does that, and
/// Docker is unavailable here. See the Phase A report's NOT VERIFIED section.

// Row ids are UUIDs, as `user_devices.id` is in PostgreSQL. The fake
// `findOwned` below refuses anything else, the way PostgreSQL does, so a test can
// no longer pass by handing a client id to the row-id lookup.
const DEV_A = '00000000-0000-7000-8000-00000000000a';
const DEV_B = '00000000-0000-7000-8000-00000000000b';
const DEV_B2 = '00000000-0000-7000-8000-0000000000b2';
const DEV_C = '00000000-0000-7000-8000-00000000000c';
const DEV_D = '00000000-0000-7000-8000-00000000000d';
const DEV_SESSION = '00000000-0000-7000-8000-000000000005';

const TX = { __tx: true } as unknown as TransactionClient;

interface DeviceRow {
  id: string;
  userId: string;
  deviceId: string | null;
  fcmToken: string | null;
  trustState: 'REGISTERED' | 'TRUSTED' | 'SUSPICIOUS' | 'REVOKED';
  revokedAt: Date | null;
}

function makeService(opts: {
  rows?: DeviceRow[];
  sessionDeviceId?: string | null;
  failOn?: 'clearOthers' | 'updateToken' | 'create' | 'link';
}) {
  // `committed` is the durable store. `staged` is what the current transaction has
  // written. A thrown callback discards `staged`, which is the rollback.
  const committed: DeviceRow[] = (opts.rows ?? []).map((r) => ({ ...r }));
  let staged: DeviceRow[] | null = null;
  const rows = (): DeviceRow[] => staged ?? committed;

  const calls: string[] = [];
  const txSeen: Array<unknown> = [];
  const published: PublishInput[] = [];

  const deviceRepository = {
    async findOwned(userId: string, id: string) {
      calls.push('findOwned');
      // PostgreSQL: `invalid input syntax for type uuid` — an error, not a miss.
      if (!isUuid(id)) throw new Error(`invalid input syntax for type uuid: "${id}"`);
      return rows().find((r) => r.id === id && r.userId === userId) ?? null;
    },
    async findByUserAndDevice(userId: string, deviceId: string) {
      calls.push('findByUserAndDevice');
      return rows().find((r) => r.userId === userId && r.deviceId === deviceId) ?? null;
    },
    async linkClientDeviceId(id: string, userId: string, deviceId: string, tx?: unknown) {
      calls.push('link');
      txSeen.push(tx);
      if (opts.failOn === 'link') throw new Error('link failed');
      const target = rows().find((r) => r.id === id && r.userId === userId && r.deviceId === null);
      if (!target) return false;
      target.deviceId = deviceId;
      return true;
    },
    async lockFcmToken(_token: string, tx?: unknown) {
      calls.push('lock');
      txSeen.push(tx);
    },
    async clearFcmTokenForOtherUsers(token: string, keepUserId: string, tx?: unknown) {
      calls.push('clearOthers');
      txSeen.push(tx);
      if (opts.failOn === 'clearOthers') throw new Error('clearOthers failed');
      let count = 0;
      for (const row of rows()) {
        if (row.fcmToken === token && row.userId !== keepUserId) {
          row.fcmToken = null;
          count += 1;
        }
      }
      return count;
    },
    async updateFcmToken(id: string, fcmToken: string, tx?: unknown) {
      calls.push('updateToken');
      txSeen.push(tx);
      if (opts.failOn === 'updateToken') throw new Error('updateToken failed');
      const row = rows().find((r) => r.id === id);
      if (row) row.fcmToken = fcmToken;
      return row;
    },
    async touchLastSeen(_id: string, _at?: Date, tx?: unknown) {
      calls.push('touchLastSeen');
      txSeen.push(tx);
    },
    async create(input: { userId: string; deviceId?: string; fcmToken?: string }, tx?: unknown) {
      calls.push('create');
      txSeen.push(tx);
      if (opts.failOn === 'create') throw new Error('create failed');
      const row: DeviceRow = {
        id: randomUUID(),
        userId: input.userId,
        deviceId: input.deviceId ?? null,
        fcmToken: input.fcmToken ?? null,
        trustState: 'REGISTERED',
        revokedAt: null,
      };
      rows().push(row);
      return row;
    },
    /// Mirrors the repository's invariant: the REVOKED transition also stamps
    /// revokedAt and releases the token; any other transition clears revokedAt.
    async updateTrustState(
      id: string,
      state: DeviceRow['trustState'],
      tx?: unknown,
      at: Date = new Date(),
    ) {
      calls.push('updateTrustState');
      txSeen.push(tx);
      const row = rows().find((r) => r.id === id);
      if (!row) throw new Error('not found');
      row.trustState = state;
      if (state === 'REVOKED') {
        row.revokedAt = at;
        row.fcmToken = null;
      } else {
        row.revokedAt = null;
      }
      return row;
    },
  };

  const sessionService = {
    async deviceIdFor() {
      return opts.sessionDeviceId === undefined ? null : opts.sessionDeviceId;
    },
    async revokeDeviceSessions() {
      return 2;
    },
  };

  const transactionManager = {
    async execute<T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> {
      staged = committed.map((r) => ({ ...r }));
      try {
        const result = await cb(TX);
        // Commit: the staged copy becomes durable.
        committed.length = 0;
        committed.push(...staged);
        return result;
      } finally {
        // Rollback happens by omission. A thrown callback skips the commit above
        // and this discards the staged copy, so `committed` is never touched —
        // which is the property the atomicity tests assert.
        staged = null;
      }
    },
  };

  const service = new DeviceService(
    deviceRepository as never,
    sessionService as never,
    { deviceRegistered: () => {}, deviceRevoked: () => {} } as never,
    {
      publish: async (input: PublishInput) => {
        published.push(input);
      },
    } as never,
    transactionManager as never,
  );

  return { service, committed, calls, txSeen, published };
}

const TOKEN = 'shared-handset-token';

function row(over: Partial<DeviceRow> & { id: string; userId: string }): DeviceRow {
  return {
    deviceId: `client-${over.id}`,
    fcmToken: null,
    trustState: 'REGISTERED',
    revokedAt: null,
    ...over,
  };
}

// ── A. Successful registration ─────────────────────────────────────────────

describe('PA-6 · A · successful registration', () => {
  it('writes the token to the claimant’s existing device', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_B, userId: 'uB' })],
    });

    const result = await service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B);

    assert.deepEqual(result, { deviceId: DEV_B, fcmToken: TOKEN });
    assert.equal(committed.find((r) => r.id === DEV_B)?.fcmToken, TOKEN);
  });

  it('creates a device row when the client id is new, using the supplied id', async () => {
    const { service, committed } = makeService({ rows: [] });

    const result = await service.updateFcmToken('uB', 'sess-1', TOKEN, 'client-xyz');

    const created = committed.find((r) => r.deviceId === 'client-xyz');
    assert.ok(created, 'a row must exist for the supplied client device id');
    assert.equal(created?.fcmToken, TOKEN);
    assert.equal(result.deviceId, created?.id);
  });

  it('resolves the device from the session when the body omits one', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_SESSION, userId: 'uB' })],
      sessionDeviceId: DEV_SESSION,
    });

    const result = await service.updateFcmToken('uB', 'sess-1', TOKEN);

    assert.equal(result.deviceId, DEV_SESSION);
    assert.equal(committed.find((r) => r.id === DEV_SESSION)?.fcmToken, TOKEN);
  });
});

// ── B + C. Cross-user collision, claimant preserved ────────────────────────

describe('PA-6 · B and C · cross-user collision', () => {
  it('releases the token from the other user and leaves the claimant deliverable', async () => {
    const { service, committed } = makeService({
      rows: [
        row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }), // logged-out previous owner
        row({ id: DEV_B, userId: 'uB' }), // now claiming it
      ],
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B);

    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, null, 'A must be released');
    assert.equal(committed.find((r) => r.id === DEV_B)?.fcmToken, TOKEN, 'B must hold it');
  });

  it('releases it from every other holder, and from revoked rows too', async () => {
    const { service, committed } = makeService({
      rows: [
        row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }),
        row({ id: DEV_C, userId: 'uC', fcmToken: TOKEN, trustState: 'REVOKED' }),
        row({ id: DEV_B, userId: 'uB' }),
      ],
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B);

    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, null);
    assert.equal(committed.find((r) => r.id === DEV_C)?.fcmToken, null);
    assert.equal(committed.find((r) => r.id === DEV_B)?.fcmToken, TOKEN);
  });

  it('leaves unrelated users and unrelated tokens alone', async () => {
    const { service, committed } = makeService({
      rows: [
        row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }),
        row({ id: DEV_D, userId: 'uD', fcmToken: 'someone-elses-token' }),
        row({ id: DEV_B2, userId: 'uB', fcmToken: 'uB-tablet' }),
        row({ id: DEV_B, userId: 'uB' }),
      ],
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B);

    assert.equal(committed.find((r) => r.id === DEV_D)?.fcmToken, 'someone-elses-token');
    assert.equal(committed.find((r) => r.id === DEV_B2)?.fcmToken, 'uB-tablet');
  });

  it('releases before claiming, so no window exists where two users hold it', async () => {
    const { service, calls } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }), row({ id: DEV_B, userId: 'uB' })],
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B);

    assert.ok(
      calls.indexOf('clearOthers') < calls.indexOf('updateToken'),
      `release must precede claim, got ${calls.join(' → ')}`,
    );
  });
});

// ── D + E. Atomicity ───────────────────────────────────────────────────────

describe('PA-6 · D and E · atomicity', () => {
  it('D · a failed token write rolls back the cross-user release', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }), row({ id: DEV_B, userId: 'uB' })],
      failOn: 'updateToken',
    });

    await assert.rejects(() => service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B));

    // A must NOT have been stripped of a token nobody took ownership of.
    assert.equal(
      committed.find((r) => r.id === DEV_A)?.fcmToken,
      TOKEN,
      'the release must be rolled back with the failed claim',
    );
    assert.equal(committed.find((r) => r.id === DEV_B)?.fcmToken, null);
  });

  it('D · a failed create rolls back the cross-user release', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN })],
      failOn: 'create',
    });

    await assert.rejects(() => service.updateFcmToken('uB', 'sess-1', TOKEN, 'client-new'));

    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, TOKEN);
    assert.equal(committed.length, 1, 'no partial device row may survive');
  });

  it('E · a failed release means the claim never commits', async () => {
    const { service, committed, calls } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }), row({ id: DEV_B, userId: 'uB' })],
      failOn: 'clearOthers',
    });

    await assert.rejects(() => service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B));

    assert.ok(
      !calls.includes('updateToken'),
      'the claim must not be attempted after a failed release',
    );
    assert.equal(
      committed.find((r) => r.id === DEV_B)?.fcmToken,
      null,
      'the claimant must not hold a token while the previous owner still does',
    );
    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, TOKEN);
  });

  it('runs the release and the claim on the same transaction client', async () => {
    const { service, txSeen } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }), row({ id: DEV_B, userId: 'uB' })],
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B);

    assert.ok(txSeen.length >= 2, 'both writes must receive a client');
    for (const tx of txSeen) {
      assert.equal(tx, TX, 'every write must use the transaction client, not the default one');
    }
  });
});

// ── F + G. Revoke, and re-registration afterwards ──────────────────────────

describe('PA-6 · F and G · revoke', () => {
  it('F · clears fcmToken and stamps revokedAt, keeping trustState REVOKED', async () => {
    const { service, committed, published } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN })],
    });

    const before = Date.now();
    await service.revoke(DEV_A, 'self');
    const after = Date.now();

    const device = committed.find((r) => r.id === DEV_A);
    assert.equal(device?.trustState, 'REVOKED');
    assert.equal(device?.fcmToken, null, 'a revoked device must not stay deliverable');
    assert.ok(device?.revokedAt, 'revokedAt must be populated');
    const stamped = device?.revokedAt?.getTime() ?? 0;
    assert.ok(stamped >= before && stamped <= after, 'revokedAt must be the revocation instant');

    // Existing semantics preserved: the event is still published.
    assert.equal(published.length, 1);
    assert.equal(published[0]?.type, 'auth.device.revoked');
  });

  it('G · re-registering after revoke restores a deliverable device', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN })],
    });

    await service.revoke(DEV_A, 'self');
    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, null);

    // The client relaunches and re-registers the same device.
    const result = await service.updateFcmToken('uA', 'sess-1', 'fresh-token', DEV_A);

    assert.equal(result.deviceId, DEV_A);
    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, 'fresh-token');
  });

  it('G · register() still flips a REVOKED device back to REGISTERED', async () => {
    // Pre-existing behaviour on the login path, unchanged by PA-6.
    const { service, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', trustState: 'REVOKED', deviceId: 'client-a' })],
    });

    await service.register({ userId: 'uA', deviceId: 'client-a' });

    assert.equal(committed.find((r) => r.id === DEV_A)?.trustState, 'REGISTERED');
  });
});

// ── H. NULL deviceId is refused ────────────────────────────────────────────

describe('PA-6 · H · a registration with no device is refused', () => {
  it('throws DeviceIdRequiredError rather than creating an unbound row', async () => {
    const { service, committed, calls } = makeService({ rows: [], sessionDeviceId: null });

    await assert.rejects(
      () => service.updateFcmToken('uB', 'sess-1', TOKEN),
      (err: unknown) => {
        assert.ok(err instanceof DeviceIdRequiredError);
        assert.equal((err as DeviceIdRequiredError).code, 'VALIDATION');
        return true;
      },
    );

    assert.equal(committed.length, 0, 'no device row may be created');
    assert.ok(!calls.includes('create'), 'create must not be reached');
    assert.ok(!calls.includes('clearOthers'), 'no transaction should be opened at all');
  });

  it('does not invent a deviceId', async () => {
    const { service, committed } = makeService({ rows: [], sessionDeviceId: null });
    await assert.rejects(() => service.updateFcmToken('uB', 'sess-1', TOKEN));
    assert.equal(
      committed.filter((r) => r.deviceId === null).length,
      0,
      'no NULL-deviceId row may exist',
    );
  });

  it('still succeeds when only the session supplies the device', async () => {
    // The rejection must be narrow: a client that sends no body deviceId but has a
    // session-bound device is the ordinary refresh case and must keep working.
    const { service, committed } = makeService({
      rows: [row({ id: DEV_SESSION, userId: 'uB' })],
      sessionDeviceId: DEV_SESSION,
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN);

    assert.equal(committed.find((r) => r.id === DEV_SESSION)?.fcmToken, TOKEN);
  });
});

// ── PA-8a · device id contract ─────────────────────────────────────────────
//
// The body `deviceId` is the client's stable id (`user_devices.device_id`); a row
// UUID is still accepted. Non-UUID ids used to reach the UUID row lookup first,
// which PostgreSQL rejects — a 500 for every shipped client.

describe('PA-8a · body deviceId resolution', () => {
  it('1 · a UUID target resolves through findOwned', async () => {
    const { service, calls, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA' })],
    });

    const result = await service.updateFcmToken('uA', 'sess-1', TOKEN, DEV_A);

    assert.equal(result.deviceId, DEV_A);
    assert.ok(calls.includes('findOwned'));
    assert.ok(!calls.includes('findByUserAndDevice'), 'a row-id hit needs no client-id lookup');
    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, TOKEN);
  });

  it('2 · a non-UUID target resolves through findByUserAndDevice', async () => {
    const { service, calls, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', deviceId: 'dev_abc_123' })],
    });

    const result = await service.updateFcmToken('uA', 'sess-1', TOKEN, 'dev_abc_123');

    assert.equal(result.deviceId, DEV_A);
    assert.ok(calls.includes('findByUserAndDevice'));
    assert.equal(committed.length, 1, 'no second row');
    assert.equal(committed[0]?.fcmToken, TOKEN);
  });

  it('3 · a non-UUID target never reaches the UUID row lookup', async () => {
    for (const id of ['dev_abc_123', 'MMB29K', 'dev-a1']) {
      const { service, calls } = makeService({
        rows: [row({ id: DEV_A, userId: 'uA', deviceId: id })],
      });
      await service.updateFcmToken('uA', 'sess-1', TOKEN, id);
      assert.ok(!calls.includes('findOwned'), `findOwned must not see "${id}"`);
    }
  });

  it('4 · a UUID that is not a row id falls back to the client-id lookup', async () => {
    const clientUuid = '11111111-1111-4111-8111-111111111111';
    const { service, calls, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', deviceId: clientUuid })],
    });

    const result = await service.updateFcmToken('uA', 'sess-1', TOKEN, clientUuid);

    assert.deepEqual(calls.slice(0, 2), ['findOwned', 'findByUserAndDevice']);
    assert.equal(result.deviceId, DEV_A);
    assert.equal(committed.length, 1);
  });
});

describe('PA-8a · session-row linking', () => {
  it('5 · links the client id onto the session row when its deviceId is NULL', async () => {
    const { service, committed, calls } = makeService({
      rows: [row({ id: DEV_SESSION, userId: 'uA', deviceId: null })],
      sessionDeviceId: DEV_SESSION,
    });

    const result = await service.updateFcmToken('uA', 'sess-1', TOKEN, 'dev_cust_1');

    assert.equal(result.deviceId, DEV_SESSION, 'the session row, not a new one');
    assert.equal(committed.length, 1, 'no second row may be created');
    assert.equal(committed[0]?.deviceId, 'dev_cust_1');
    assert.equal(committed[0]?.fcmToken, TOKEN);
    assert.ok(!calls.includes('create'));
  });

  it('6 · never overwrites a session row that already has a deviceId', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_SESSION, userId: 'uA', deviceId: 'dev_existing', fcmToken: 'old' })],
      sessionDeviceId: DEV_SESSION,
    });

    const result = await service.updateFcmToken('uA', 'sess-1', TOKEN, 'dev_other');

    const session = committed.find((r) => r.id === DEV_SESSION);
    assert.equal(session?.deviceId, 'dev_existing', 'existing identity must be preserved');
    assert.equal(session?.fcmToken, 'old');
    assert.notEqual(result.deviceId, DEV_SESSION);
  });

  it('7 · an unknown client id creates a new row when the session row is populated', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_SESSION, userId: 'uA', deviceId: 'dev_existing' })],
      sessionDeviceId: DEV_SESSION,
    });

    const result = await service.updateFcmToken('uA', 'sess-1', TOKEN, 'dev_new');

    const created = committed.find((r) => r.deviceId === 'dev_new');
    assert.ok(created);
    assert.equal(created?.userId, 'uA');
    assert.equal(created?.fcmToken, TOKEN);
    assert.equal(result.deviceId, created?.id);
    assert.equal(committed.length, 2);
  });

  it('8 · another user cannot claim a row by its client id or its row id', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', deviceId: 'dev_a_phone', fcmToken: 'a-token' })],
    });

    const byClient = await service.updateFcmToken('uB', 'sess-b', TOKEN, 'dev_a_phone');
    const byRow = await service.updateFcmToken('uB', 'sess-b', 'tok-2', DEV_A);

    const a = committed.find((r) => r.id === DEV_A);
    assert.equal(a?.userId, 'uA');
    assert.equal(a?.fcmToken, 'a-token', 'the other user row must be untouched');
    assert.notEqual(byClient.deviceId, DEV_A);
    assert.notEqual(byRow.deviceId, DEV_A);
  });

  it('8 · a session row belonging to another user is never linked', async () => {
    // Defence in depth: the link is scoped by userId in the write itself.
    const { service, committed } = makeService({
      rows: [row({ id: DEV_SESSION, userId: 'uA', deviceId: null })],
      sessionDeviceId: DEV_SESSION,
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN, 'dev_b');

    assert.equal(committed.find((r) => r.id === DEV_SESSION)?.deviceId, null);
  });

  it('9 · a failure after linking rolls back the link and the release', async () => {
    const { service, committed } = makeService({
      rows: [
        row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }),
        row({ id: DEV_SESSION, userId: 'uB', deviceId: null }),
      ],
      sessionDeviceId: DEV_SESSION,
      failOn: 'updateToken',
    });

    await assert.rejects(() => service.updateFcmToken('uB', 'sess-1', TOKEN, 'dev_b'));

    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, TOKEN, 'release rolled back');
    const session = committed.find((r) => r.id === DEV_SESSION);
    assert.equal(session?.deviceId, null, 'link rolled back');
    assert.equal(session?.fcmToken, null);
  });

  it('9 · a failed link rolls back the release', async () => {
    const { service, committed } = makeService({
      rows: [
        row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }),
        row({ id: DEV_SESSION, userId: 'uB', deviceId: null }),
      ],
      sessionDeviceId: DEV_SESSION,
      failOn: 'link',
    });

    await assert.rejects(() => service.updateFcmToken('uB', 'sess-1', TOKEN, 'dev_b'));

    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, TOKEN);
    assert.equal(committed.length, 2);
  });

  it('runs the link on the same transaction client as the release', async () => {
    const { service, txSeen, calls } = makeService({
      rows: [row({ id: DEV_SESSION, userId: 'uA', deviceId: null })],
      sessionDeviceId: DEV_SESSION,
    });

    await service.updateFcmToken('uA', 'sess-1', TOKEN, 'dev_x');

    assert.ok(calls.includes('link'));
    for (const tx of txSeen) assert.equal(tx, TX);
  });
});

// ── Token ownership · register() obeys the same rule as updateFcmToken() ────

describe('Token ownership · register()', () => {
  it('a new device row claims the token after releasing it from other users', async () => {
    const { service, committed, calls } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN })],
    });

    await service.register({ userId: 'uB', deviceId: 'client-b', fcmToken: TOKEN });

    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, null, 'A released');
    assert.equal(committed.find((r) => r.deviceId === 'client-b')?.fcmToken, TOKEN, 'B holds it');
    assert.deepEqual(calls.slice(0, 2), ['lock', 'clearOthers'], 'lock, then release, then claim');
    assert.ok(calls.indexOf('clearOthers') < calls.indexOf('create'));
  });

  it('an existing device row claims the token too', async () => {
    const { service, committed } = makeService({
      rows: [
        row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }),
        row({ id: DEV_B, userId: 'uB', deviceId: 'client-b' }),
      ],
    });

    const device = await service.register({ userId: 'uB', deviceId: 'client-b', fcmToken: TOKEN });

    assert.equal(device.id, DEV_B, 'no new row');
    assert.equal(committed.length, 2);
    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, null);
    assert.equal(committed.find((r) => r.id === DEV_B)?.fcmToken, TOKEN);
  });

  it('leaves the other user their unrelated tokens', async () => {
    const { service, committed } = makeService({
      rows: [
        row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN }),
        row({ id: DEV_C, userId: 'uA', fcmToken: 'a-tablet' }),
      ],
    });

    await service.register({ userId: 'uB', deviceId: 'client-b', fcmToken: TOKEN });

    assert.equal(committed.find((r) => r.id === DEV_C)?.fcmToken, 'a-tablet');
  });

  it('is idempotent for the same user and token', async () => {
    const { service, committed, calls } = makeService({
      rows: [row({ id: DEV_B, userId: 'uB', deviceId: 'client-b', fcmToken: TOKEN })],
    });

    await service.register({ userId: 'uB', deviceId: 'client-b', fcmToken: TOKEN });

    assert.equal(committed.length, 1);
    assert.equal(committed[0]?.fcmToken, TOKEN);
    assert.ok(!calls.includes('updateToken'), 'no redundant write');
    assert.ok(!calls.includes('create'));
  });

  it('takes no lock and releases nothing when no token is supplied', async () => {
    const { service, calls, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN })],
    });

    await service.register({ userId: 'uB', deviceId: 'client-b' });

    assert.ok(!calls.includes('lock'));
    assert.ok(!calls.includes('clearOthers'));
    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, TOKEN);
  });

  it('a failed create rolls back the release', async () => {
    const { service, committed } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN })],
      failOn: 'create',
    });

    await assert.rejects(() =>
      service.register({ userId: 'uB', deviceId: 'client-b', fcmToken: TOKEN }),
    );

    assert.equal(committed.find((r) => r.id === DEV_A)?.fcmToken, TOKEN, 'A keeps it');
    assert.equal(committed.length, 1);
  });

  it('opens its own transaction when the caller has none, and uses it throughout', async () => {
    const { service, txSeen } = makeService({
      rows: [row({ id: DEV_A, userId: 'uA', fcmToken: TOKEN })],
    });

    await service.register({ userId: 'uB', deviceId: 'client-b', fcmToken: TOKEN });

    assert.ok(txSeen.length >= 3);
    for (const tx of txSeen) assert.equal(tx, TX);
  });
});

describe('Token ownership · updateFcmToken() locks before releasing', () => {
  it('takes the token lock first, on the same transaction', async () => {
    const { service, calls, txSeen } = makeService({
      rows: [row({ id: DEV_B, userId: 'uB' })],
    });

    await service.updateFcmToken('uB', 'sess-1', TOKEN, DEV_B);

    assert.deepEqual(calls.filter((c) => c !== 'findOwned').slice(0, 2), ['lock', 'clearOthers']);
    for (const tx of txSeen) assert.equal(tx, TX);
  });
});
