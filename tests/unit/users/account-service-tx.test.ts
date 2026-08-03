import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AccountService } from '../../../src/modules/users/account.service.js';
import {
  AccountHasObligationsError,
  AccountNotDeactivatedError,
  UserNotFoundError,
} from '../../../src/modules/users/errors.js';
import { userConfig } from '../../../src/config/user/index.js';
import type { Obligation } from '../../../src/modules/users/repositories/obligations.repository.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

/** The sentinel the fake TransactionManager hands to the departure callback. */
const TX = { __tx: true } as unknown as TransactionClient;

const USER_ID = '00000000-0000-7000-8000-000000000001';

interface Options {
  /** What the cross-module read reports. */
  obligations?: Obligation[];
  /** Whether AUTH found the account already deactivated. */
  already?: boolean;
  /** The identity `findById` reports — `null` for an account that is not there. */
  user?: { id: string; status: string; deletedAt: Date | null } | null;
}

function makeService(opts: Options = {}) {
  const seen = {
    order: [] as string[],
    published: [] as { input: PublishInput; tx: unknown }[],
  };

  const obligationsRepository = {
    findOpenObligations: async () => {
      seen.order.push('obligations');
      return opts.obligations ?? [];
    },
  };
  const userRepository = {
    findById: async () =>
      opts.user === undefined ? { id: USER_ID, status: 'DEACTIVATED', deletedAt: null } : opts.user,
  };
  const authService = {
    deactivateInTransaction: async (_userId: string, tx: TransactionClient) => {
      seen.order.push(tx === TX ? 'deactivate' : 'deactivate:OUTSIDE_TX');
      return { alreadyDeactivated: opts.already ?? false, sessionsRevoked: 2 };
    },
    activateInTransaction: async (_userId: string, tx: TransactionClient) => {
      seen.order.push(tx === TX ? 'activate' : 'activate:OUTSIDE_TX');
    },
  };
  const epochService = {
    bump: async () => {
      seen.order.push('epoch:bump');
      return 2;
    },
  };
  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => {
      seen.order.push('tx:begin');
      const out = await cb(TX);
      seen.order.push('tx:commit');
      return out;
    },
  };
  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.published.push({ input, tx });
      seen.order.push(`publish:${input.type}`);
    },
  };

  const service = new AccountService(
    obligationsRepository as never,
    userRepository as never,
    authService as never,
    epochService as never,
    transactionManager as never,
    eventPublisher as never,
  );
  return { service, seen };
}

describe('AccountService.deactivate (unit)', () => {
  it('shuts the account and audits it in one transaction, then bumps the epoch', async () => {
    const { service, seen } = makeService();
    await service.deactivate(USER_ID, 'NOT_USING');

    assert.deepEqual(seen.order, [
      'obligations',
      'tx:begin',
      'deactivate',
      'publish:user.account.deactivated',
      'tx:commit',
      'epoch:bump',
    ]);
    // The bump is a Redis write and belongs after the commit (R-USER-30); the
    // status change and its audit trail belong together (R-USER-29).
    assert.equal(seen.published[0]!.tx, TX, 'the audit event commits with the status change');
  });

  it('reads obligations before opening the transaction, not inside it', async () => {
    const { service, seen } = makeService();
    await service.deactivate(USER_ID);
    // Three other modules' tables are read here. Holding a write transaction open
    // across them would put this flow in their lock path.
    assert.ok(seen.order.indexOf('obligations') < seen.order.indexOf('tx:begin'));
  });

  it('refuses while anything is in flight, naming every blocking module', async () => {
    const obligations: Obligation[] = [
      { module: 'rides', code: 'RIDE_IN_PROGRESS' },
      { module: 'wallet', code: 'BALANCE_UNSETTLED' },
    ];
    const { service, seen } = makeService({ obligations });

    await assert.rejects(service.deactivate(USER_ID), (err: unknown) => {
      assert.ok(err instanceof AccountHasObligationsError);
      // doc 04 §3: `details` names the blocking module so the client can link
      // straight to it — and it names all of them, not one per attempt.
      assert.deepEqual(err.details, [
        { field: 'rides', code: 'RIDE_IN_PROGRESS' },
        { field: 'wallet', code: 'BALANCE_UNSETTLED' },
      ]);
      return true;
    });
    assert.deepEqual(seen.order, ['obligations'], 'nothing was written and nobody was signed out');
  });

  it('is a silent no-op on an account that is already deactivated', async () => {
    const { service, seen } = makeService({ already: true });
    await service.deactivate(USER_ID);

    assert.equal(seen.published.length, 0, 'no second departure to audit');
    assert.equal(seen.order.includes('epoch:bump'), false, 'and no second revocation storm');
  });

  it('carries the coarse reason, and omits it when the client gave none', async () => {
    for (const reason of userConfig.deactivationReasons) {
      const { service, seen } = makeService();
      await service.deactivate(USER_ID, reason);
      assert.deepEqual(seen.published[0]!.input.data, { userId: USER_ID, actor: 'self', reason });
    }

    const { service, seen } = makeService();
    await service.deactivate(USER_ID);
    assert.deepEqual(seen.published[0]!.input.data, { userId: USER_ID, actor: 'self' });
  });

  it('marks the departure as the user’s own, not an ops suspension', async () => {
    const { service, seen } = makeService();
    await service.deactivate(USER_ID, 'PRIVACY');

    const event = seen.published[0]!.input;
    assert.equal(event.type, 'user.account.deactivated');
    assert.equal(event.producer, 'users');
    assert.equal(event.classification, 'audit', 'doc 05 §4 — written with the change it records');
    // AUTH's `account.suspended` is the ops counterpart; different business event,
    // different notification copy (doc 05 §3.3).
    assert.equal(event.data.actor, 'self');
  });
});

describe('AccountService.requestDeletion (unit)', () => {
  it('deactivates and records the request in the same transaction', async () => {
    const { service, seen } = makeService();
    await service.requestDeletion(USER_ID);

    assert.deepEqual(seen.order, [
      'obligations',
      'tx:begin',
      'deactivate',
      'publish:user.account.deactivated',
      'publish:user.account.deletion_requested',
      'tx:commit',
      'epoch:bump',
    ]);
    // An account whose deletion is on record is always already shut — the two can
    // never diverge because they commit together.
    for (const published of seen.published) assert.equal(published.tx, TX);
  });

  it('schedules erasure the configured window ahead, and erases nothing itself', async () => {
    const { service, seen } = makeService();
    const before = Date.now();
    const { scheduledFor } = await service.requestDeletion(USER_ID);

    const scheduled = new Date(scheduledFor).getTime();
    const expected = before + userConfig.deletionRetentionDays * 86_400_000;
    assert.ok(Math.abs(scheduled - expected) < 5_000, scheduledFor);

    const event = seen.published[1]!.input;
    assert.equal(event.type, 'user.account.deletion_requested');
    assert.deepEqual(event.data, { userId: USER_ID, scheduledFor });
    assert.equal(event.classification, 'audit');
  });

  it('is refused by the same obligations as a plain deactivation', async () => {
    const { service } = makeService({
      obligations: [{ module: 'support', code: 'DISPUTE_OPEN' }],
    });
    await assert.rejects(service.requestDeletion(USER_ID), AccountHasObligationsError);
  });

  it('keeps every payload free of a personal value (doc 05 §5)', async () => {
    const { service, seen } = makeService();
    await service.requestDeletion(USER_ID);

    // Identifiers, coarse enums, and a timestamp — nothing else.
    const keys = seen.published.flatMap((p) => Object.keys(p.input.data));
    assert.deepEqual(new Set(keys), new Set(['userId', 'actor', 'scheduledFor']));
  });
});

const ACTOR_ID = '00000000-0000-7000-8000-0000000000ad';

// The `admin` module's seam (R-USER-17, doc 05 §3.3). There is no route: a
// deactivated account cannot authenticate, so no authenticated call by its owner
// could reach this, and doc 02 exposes nothing that would let one try.
describe('AccountService.restore (unit)', () => {
  it('returns the account to ACTIVE and audits it in one transaction', async () => {
    const { service, seen } = makeService();
    await service.restore(USER_ID, ACTOR_ID);

    assert.deepEqual(seen.order, [
      'tx:begin',
      'activate',
      'publish:user.account.restored',
      'tx:commit',
    ]);
    assert.equal(seen.published[0]!.tx, TX, 'the event commits with the status change');
  });

  it('records the operator, not just the subject', async () => {
    const { service, seen } = makeService();
    await service.restore(USER_ID, ACTOR_ID);

    const event = seen.published[0]!.input;
    assert.equal(event.type, 'user.account.restored');
    assert.equal(event.producer, 'users');
    assert.equal(event.classification, 'audit');
    assert.equal(event.subjectUserId, USER_ID, 'the subject is the restored account');
    assert.deepEqual(event.data, { userId: USER_ID, actor: 'admin', actorId: ACTOR_ID });
  });

  it('never lowers the epoch — reactivation returns access, not credentials', async () => {
    const { service, seen } = makeService();
    await service.restore(USER_ID, ACTOR_ID);

    // The epoch was raised to invalidate the tokens the departure revoked. The
    // user logs in again; nothing that was revoked comes back (R-AUTH-13).
    assert.equal(seen.order.includes('epoch:bump'), false);
  });

  it('refuses an account that was never self-deactivated', async () => {
    // A return from ops suspension is AUTH's `activate`, which emits AUTH's
    // `account.reactivated` — a different business event (doc 05 §3.3).
    for (const status of ['ACTIVE', 'SUSPENDED', 'UNVERIFIED']) {
      const { service, seen } = makeService({
        user: { id: USER_ID, status, deletedAt: null },
      });
      await assert.rejects(service.restore(USER_ID, ACTOR_ID), AccountNotDeactivatedError, status);
      assert.deepEqual(seen.order, [], `${status}: nothing was written`);
    }
  });

  it('refuses an identity that is gone, or erased', async () => {
    for (const user of [null, { id: USER_ID, status: 'DEACTIVATED', deletedAt: new Date() }]) {
      const { service, seen } = makeService({ user });
      await assert.rejects(service.restore(USER_ID, ACTOR_ID), UserNotFoundError);
      assert.equal(seen.published.length, 0);
    }
  });
});
