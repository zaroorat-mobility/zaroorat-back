import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeviceRepository } from '../../../src/modules/auth/repositories/device.repository.js';
import type { DatabaseService } from '../../../src/core/database/DatabaseService.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

/// PA-5 — the two queries that decide who a notification reaches.
///
/// These assert the query the repository *builds*, not Postgres's behaviour.
/// `trustState: { not: 'REVOKED' }` either appears in the predicate or it does
/// not, and that is the whole defect: a revoked device kept its token and stayed
/// the newest row, so it went on receiving every notification. An in-memory
/// double over `userDevice` is enough to pin that, and it runs without a database
/// — which matters, because the Postgres-backed device suites cannot run here at
/// all (no Docker).
///
/// The row-level consequences are asserted too, by filtering the fixture rows with
/// the captured predicate, so an ordering or scoping regression fails here rather
/// than waiting for an integration environment.

interface DeviceRow {
  id: string;
  userId: string;
  fcmToken: string | null;
  trustState: 'REGISTERED' | 'TRUSTED' | 'SUSPICIOUS' | 'REVOKED';
  lastSeenAt: Date | null;
  createdAt: Date;
}

const at = (iso: string): Date => new Date(iso);

/// Applies the subset of Prisma `where` semantics these two queries use.
function matches(row: DeviceRow, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = (row as unknown as Record<string, unknown>)[field];
    if (condition !== null && typeof condition === 'object') {
      const { not } = condition as { not?: unknown };
      if (not === null) {
        if (value === null) return false;
      } else if (not !== undefined) {
        if (value === not) return false;
      }
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

/// Orders by `[{ lastSeenAt: desc, nulls: last }, { createdAt: desc }]`.
function orderRows(rows: DeviceRow[]): DeviceRow[] {
  return [...rows].sort((a, b) => {
    if (a.lastSeenAt && b.lastSeenAt) {
      const diff = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
      if (diff !== 0) return diff;
    } else if (a.lastSeenAt && !b.lastSeenAt) {
      return -1; // nulls last
    } else if (!a.lastSeenAt && b.lastSeenAt) {
      return 1;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

function makeRepo(rows: DeviceRow[]) {
  const captured = {
    findFirstArgs: undefined as Record<string, unknown> | undefined,
    updateManyArgs: undefined as Record<string, unknown> | undefined,
  };
  const store = rows.map((r) => ({ ...r }));

  const userDevice = {
    async findFirst(args: Record<string, unknown>) {
      captured.findFirstArgs = args;
      const where = args.where as Record<string, unknown>;
      const hit = orderRows(store.filter((r) => matches(r, where)))[0];
      return hit ? { fcmToken: hit.fcmToken } : null;
    },
    async updateMany(args: Record<string, unknown>) {
      captured.updateManyArgs = args;
      const where = args.where as Record<string, unknown>;
      const data = args.data as Partial<DeviceRow>;
      let count = 0;
      for (const row of store) {
        if (matches(row, where)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  };

  const databaseService = { client: { userDevice } } as unknown as DatabaseService;
  return { repo: new DeviceRepository(databaseService), captured, store };
}

const BASE: Omit<DeviceRow, 'id' | 'userId' | 'fcmToken' | 'trustState'> = {
  lastSeenAt: at('2026-09-01T00:00:00Z'),
  createdAt: at('2026-08-01T00:00:00Z'),
};

describe('PA-5 · findLatestFcmToken excludes revoked devices', () => {
  it('puts trustState in the predicate alongside userId and a non-null token', async () => {
    const { repo, captured } = makeRepo([]);
    await repo.findLatestFcmToken('u1');

    assert.deepEqual(captured.findFirstArgs?.where, {
      userId: 'u1',
      fcmToken: { not: null },
      trustState: { not: 'REVOKED' },
    });
  });

  it('never returns a REVOKED device, even when it is the newest', async () => {
    // The exact shape of the defect: revoke() marks the row REVOKED and leaves
    // the token, and the revoked row is the most recently seen.
    const { repo } = makeRepo([
      {
        ...BASE,
        id: 'd-old',
        userId: 'u1',
        fcmToken: 'token-active',
        trustState: 'REGISTERED',
        lastSeenAt: at('2026-09-01T00:00:00Z'),
      },
      {
        ...BASE,
        id: 'd-revoked',
        userId: 'u1',
        fcmToken: 'token-revoked',
        trustState: 'REVOKED',
        lastSeenAt: at('2026-09-20T00:00:00Z'),
      },
    ]);

    assert.equal(await repo.findLatestFcmToken('u1'), 'token-active');
  });

  it('returns null when every device the user has is revoked', async () => {
    const { repo } = makeRepo([
      { ...BASE, id: 'd1', userId: 'u1', fcmToken: 'tok-1', trustState: 'REVOKED' },
      { ...BASE, id: 'd2', userId: 'u1', fcmToken: 'tok-2', trustState: 'REVOKED' },
    ]);

    // Correct: the delivery job turns this into NO_ACTIVE_DEVICE and counts it,
    // rather than pushing to a handset whose session was terminated.
    assert.equal(await repo.findLatestFcmToken('u1'), null);
  });

  it('still returns REGISTERED, TRUSTED and SUSPICIOUS devices', async () => {
    // Only REVOKED is excluded. SUSPICIOUS is a flag for review, not a
    // termination, and silently withholding notifications from it would be a
    // behaviour change nobody asked for.
    for (const trustState of ['REGISTERED', 'TRUSTED', 'SUSPICIOUS'] as const) {
      const { repo } = makeRepo([
        { ...BASE, id: 'd1', userId: 'u1', fcmToken: `tok-${trustState}`, trustState },
      ]);
      assert.equal(await repo.findLatestFcmToken('u1'), `tok-${trustState}`);
    }
  });
});

describe('PA-5 · ordering semantics are unchanged', () => {
  it('keeps the original orderBy: lastSeenAt desc with nulls last, then createdAt desc', async () => {
    const { repo, captured } = makeRepo([]);
    await repo.findLatestFcmToken('u1');

    assert.deepEqual(captured.findFirstArgs?.orderBy, [
      { lastSeenAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
    ]);
    assert.deepEqual(captured.findFirstArgs?.select, { fcmToken: true });
  });

  it('prefers the most recently seen active device', async () => {
    const { repo } = makeRepo([
      {
        ...BASE,
        id: 'd-older',
        userId: 'u1',
        fcmToken: 'tok-older',
        trustState: 'REGISTERED',
        lastSeenAt: at('2026-09-10T00:00:00Z'),
      },
      {
        ...BASE,
        id: 'd-newer',
        userId: 'u1',
        fcmToken: 'tok-newer',
        trustState: 'REGISTERED',
        lastSeenAt: at('2026-09-22T00:00:00Z'),
      },
    ]);

    assert.equal(await repo.findLatestFcmToken('u1'), 'tok-newer');
  });

  it('ranks a device that has never been seen below one that has', async () => {
    const { repo } = makeRepo([
      {
        id: 'd-null',
        userId: 'u1',
        fcmToken: 'tok-null-lastseen',
        trustState: 'REGISTERED',
        lastSeenAt: null,
        createdAt: at('2026-09-23T00:00:00Z'),
      },
      {
        id: 'd-seen',
        userId: 'u1',
        fcmToken: 'tok-seen',
        trustState: 'REGISTERED',
        lastSeenAt: at('2026-09-01T00:00:00Z'),
        createdAt: at('2026-08-01T00:00:00Z'),
      },
    ]);

    // nulls last, even though the never-seen row was created more recently.
    assert.equal(await repo.findLatestFcmToken('u1'), 'tok-seen');
  });

  it('falls back to createdAt desc when neither device has been seen', async () => {
    const { repo } = makeRepo([
      {
        id: 'd-a',
        userId: 'u1',
        fcmToken: 'tok-a',
        trustState: 'REGISTERED',
        lastSeenAt: null,
        createdAt: at('2026-08-01T00:00:00Z'),
      },
      {
        id: 'd-b',
        userId: 'u1',
        fcmToken: 'tok-b',
        trustState: 'REGISTERED',
        lastSeenAt: null,
        createdAt: at('2026-09-01T00:00:00Z'),
      },
    ]);

    assert.equal(await repo.findLatestFcmToken('u1'), 'tok-b');
  });

  it('ignores devices belonging to another user', async () => {
    const { repo } = makeRepo([
      {
        ...BASE,
        id: 'd-other',
        userId: 'u2',
        fcmToken: 'tok-other',
        trustState: 'REGISTERED',
        lastSeenAt: at('2026-09-23T00:00:00Z'),
      },
      { ...BASE, id: 'd-mine', userId: 'u1', fcmToken: 'tok-mine', trustState: 'REGISTERED' },
    ]);

    assert.equal(await repo.findLatestFcmToken('u1'), 'tok-mine');
  });
});

describe('PA-5 · clearFcmTokenForOtherUsers', () => {
  const SHARED = 'shared-handset-token';

  function sharedHandset() {
    return makeRepo([
      // User A: logged out, still holding the handset's token. The leak.
      { ...BASE, id: 'd-a', userId: 'uA', fcmToken: SHARED, trustState: 'REGISTERED' },
      // User B: now logged in on the same handset, claiming the same token.
      { ...BASE, id: 'd-b', userId: 'uB', fcmToken: SHARED, trustState: 'REGISTERED' },
      // Unrelated: different user, different token. Must not be touched.
      { ...BASE, id: 'd-c', userId: 'uC', fcmToken: 'unrelated-token', trustState: 'REGISTERED' },
      // Same user as the claimant, different device and token. Must survive.
      { ...BASE, id: 'd-b2', userId: 'uB', fcmToken: 'uB-tablet-token', trustState: 'REGISTERED' },
    ]);
  }

  it('scopes the update to the token value and excludes the claiming user', async () => {
    const { repo, captured } = sharedHandset();
    await repo.clearFcmTokenForOtherUsers(SHARED, 'uB');

    assert.deepEqual(captured.updateManyArgs?.where, {
      fcmToken: SHARED,
      userId: { not: 'uB' },
    });
    assert.deepEqual(captured.updateManyArgs?.data, { fcmToken: null });
  });

  it('clears the token from the other user and preserves the claimant', async () => {
    const { repo, store } = sharedHandset();
    const cleared = await repo.clearFcmTokenForOtherUsers(SHARED, 'uB');

    assert.equal(cleared, 1, 'exactly one row released');
    assert.equal(store.find((r) => r.id === 'd-a')?.fcmToken, null, "A's token must be released");
    assert.equal(store.find((r) => r.id === 'd-b')?.fcmToken, SHARED, "B's token must survive");
  });

  it('leaves unrelated users and unrelated tokens untouched', async () => {
    const { repo, store } = sharedHandset();
    await repo.clearFcmTokenForOtherUsers(SHARED, 'uB');

    assert.equal(store.find((r) => r.id === 'd-c')?.fcmToken, 'unrelated-token');
    assert.equal(store.find((r) => r.id === 'd-b2')?.fcmToken, 'uB-tablet-token');
  });

  it('does not clear a duplicate the claiming user holds on a second row', async () => {
    // A re-registration can legitimately leave the same user holding the token on
    // two rows. Clearing their own would leave them with no deliverable device.
    const { repo, store } = makeRepo([
      { ...BASE, id: 'd-1', userId: 'uB', fcmToken: SHARED, trustState: 'REGISTERED' },
      { ...BASE, id: 'd-2', userId: 'uB', fcmToken: SHARED, trustState: 'REGISTERED' },
    ]);

    const cleared = await repo.clearFcmTokenForOtherUsers(SHARED, 'uB');

    assert.equal(cleared, 0);
    assert.equal(store.filter((r) => r.fcmToken === SHARED).length, 2);
  });

  it('reports zero when the token is not held by anyone else', async () => {
    const { repo } = makeRepo([
      { ...BASE, id: 'd-b', userId: 'uB', fcmToken: SHARED, trustState: 'REGISTERED' },
    ]);

    // The ordinary case — a token registered for the first time. The count lets
    // the caller log a genuine collision instead of assuming one.
    assert.equal(await repo.clearFcmTokenForOtherUsers(SHARED, 'uB'), 0);
  });

  it('releases the token from every other user holding it, not just the first', async () => {
    const { repo, store } = makeRepo([
      { ...BASE, id: 'd-a', userId: 'uA', fcmToken: SHARED, trustState: 'REGISTERED' },
      { ...BASE, id: 'd-d', userId: 'uD', fcmToken: SHARED, trustState: 'REVOKED' },
      { ...BASE, id: 'd-b', userId: 'uB', fcmToken: SHARED, trustState: 'REGISTERED' },
    ]);

    const cleared = await repo.clearFcmTokenForOtherUsers(SHARED, 'uB');

    assert.equal(cleared, 2, 'a revoked holder is released too — trustState is irrelevant here');
    assert.equal(store.find((r) => r.id === 'd-a')?.fcmToken, null);
    assert.equal(store.find((r) => r.id === 'd-d')?.fcmToken, null);
    assert.equal(store.find((r) => r.id === 'd-b')?.fcmToken, SHARED);
  });

  it('uses the supplied transaction client when given one', async () => {
    // PA-6 will call this inside the same transaction as the token write, so a
    // partial failure cannot leave two users holding one token.
    let usedTx = false;
    const txClient = {
      userDevice: {
        async updateMany() {
          usedTx = true;
          return { count: 1 };
        },
      },
    } as unknown as TransactionClient;

    const { repo, captured } = sharedHandset();
    const cleared = await repo.clearFcmTokenForOtherUsers(SHARED, 'uB', txClient);

    assert.equal(usedTx, true, 'the transaction client must be used, not the default client');
    assert.equal(cleared, 1);
    assert.equal(captured.updateManyArgs, undefined, 'the default client must not be touched');
  });
});
