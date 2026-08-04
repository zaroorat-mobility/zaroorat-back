import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';
import type { PublishInput } from '../../../src/core/events/index.js';
import { AccountErasureJob } from '../../../src/modules/users/jobs/account-erasure.job.js';

const USER_ID = '00000000-0000-7000-8000-000000000001';
const REQUEST_ID = '00000000-0000-7000-8000-0000000000a1';
const FILE_ID = '00000000-0000-7000-8000-0000000000f1';
const NOW = new Date('2026-09-03T03:30:00.000Z');

/** A sentinel transaction client, so a test can prove a call joined the unit of work. */
const TX = { $sentinel: 'tx' } as unknown as TransactionClient;

interface Options {
  /** Requests the ledger reports as due. */
  due?: { id: string; userId: string }[];
  /** What the obligations check answers. */
  obligations?: { module: string; code: string }[];
  /** The account's avatar, if any. */
  avatar?: string | null;
  /** Make the lock unavailable, as a second runner would. */
  lockHeld?: boolean;
  /** Make `markErased` report that another runner already closed the request. */
  alreadyClosed?: boolean;
  /** Make the avatar release throw. */
  avatarFails?: boolean;
}

/** Build the job with recording fakes for everything it touches. */
function makeJob(opts: Options = {}) {
  const seen = {
    order: [] as string[],
    // `tx` is recorded, not optional: "published outside a transaction" is a
    // thing a test must be able to assert, and under exactOptionalPropertyTypes
    // an optional key cannot hold an explicit undefined.
    published: [] as { input: PublishInput; tx: TransactionClient | undefined }[],
    anonymized: [] as { userId: string; at: Date; joinedTx: boolean }[],
    releasedFiles: [] as string[],
  };

  const deletionRequestRepository = {
    findDue: async () => {
      seen.order.push('ledger:findDue');
      return opts.due ?? [{ id: REQUEST_ID, userId: USER_ID }];
    },
    markErased: async (_id: string, _at: Date, tx?: TransactionClient) => {
      seen.order.push(tx === TX ? 'ledger:markErased' : 'ledger:markErased:OUTSIDE_TX');
      return !opts.alreadyClosed;
    },
  };

  const obligationsRepository = {
    findOpenObligations: async () => {
      seen.order.push('obligations');
      return opts.obligations ?? [];
    },
  };

  const userProfileRepository = {
    findByUserId: async () => {
      seen.order.push('profile:read');
      return opts.avatar === undefined ? null : { profileImageFileId: opts.avatar };
    },
    deleteForUser: async (_userId: string, tx?: TransactionClient) => {
      seen.order.push(tx === TX ? 'delete:profile' : 'delete:profile:OUTSIDE_TX');
      return 1;
    },
  };

  const emergencyContactRepository = {
    deleteAllForUser: async (_userId: string, tx?: TransactionClient) => {
      seen.order.push(tx === TX ? 'delete:contacts' : 'delete:contacts:OUTSIDE_TX');
      return 3;
    },
  };

  const savedPlaceRepository = {
    deleteAllForUser: async (_userId: string, tx?: TransactionClient) => {
      seen.order.push(tx === TX ? 'delete:places' : 'delete:places:OUTSIDE_TX');
      return 2;
    },
  };

  const userRepository = {
    anonymize: async (userId: string, at: Date, tx?: TransactionClient) => {
      seen.order.push(tx === TX ? 'identity:anonymize' : 'identity:anonymize:OUTSIDE_TX');
      seen.anonymized.push({ userId, at, joinedTx: tx === TX });
    },
  };

  const fileService = {
    remove: async (fileId: string) => {
      seen.order.push('file:remove');
      if (opts.avatarFails) throw new Error('storage unreachable');
      seen.releasedFiles.push(fileId);
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
      seen.order.push(`publish:${input.type}`);
      seen.published.push({ input, tx });
    },
  };

  const redisService = {
    lock: {
      acquire: async () => (opts.lockHeld ? null : 'token'),
      release: async () => {
        seen.order.push('lock:release');
      },
    },
  };

  const userMetrics = {
    accountsErased: () => seen.order.push('metric:erased'),
    erasureBlocked: () => seen.order.push('metric:blocked'),
  };

  const job = new AccountErasureJob(
    deletionRequestRepository as never,
    obligationsRepository as never,
    userProfileRepository as never,
    emergencyContactRepository as never,
    savedPlaceRepository as never,
    userRepository as never,
    fileService as never,
    transactionManager as never,
    eventPublisher as never,
    redisService as never,
    userMetrics as never,
  );

  return { job, seen };
}

/**
 * The account-erasure job (R-USER-18/19, doc 03 §6).
 *
 * The only code in USER that destroys anything, so these tests are mostly about
 * what it refuses and in what order — the order being the difference between a
 * crash that retries harmlessly and a crash recorded as a completed erasure.
 */
describe('AccountErasureJob (unit)', () => {
  it('erases the personal data inside one transaction', async () => {
    const { job, seen } = makeJob();

    await job.run(NOW);

    // Every delete and the anonymization joined the same unit of work: a
    // half-erased account is not a state this can stop in.
    assert.ok(!seen.order.some((step) => step.endsWith('OUTSIDE_TX')), seen.order.join(' → '));
    for (const step of ['delete:contacts', 'delete:places', 'delete:profile']) {
      assert.ok(seen.order.includes(step), step);
    }
  });

  it('anonymizes the identity rather than deleting the row', async () => {
    // ~50 tables reference `users.id`. Removing it would take every ride,
    // ledger entry, and dispute the law requires us to keep.
    const { job, seen } = makeJob();

    await job.run(NOW);

    assert.deepEqual(seen.anonymized, [{ userId: USER_ID, at: NOW, joinedTx: true }]);
  });

  it('closes the ledger last, after the data is actually gone', async () => {
    const { job, seen } = makeJob({ avatar: FILE_ID });

    await job.run(NOW);

    const erased = seen.order.indexOf('identity:anonymize');
    const released = seen.order.indexOf('file:remove');
    const closed = seen.order.indexOf('ledger:markErased');
    // Closing first would record a crash mid-erasure as a completed erasure.
    assert.ok(erased < released, 'data before avatar');
    assert.ok(released < closed, 'avatar before the ledger closes');
  });

  it('releases the avatar only after the profile that references it is gone', async () => {
    // FILES refuses to delete a file a live row still references, and that
    // refusal is the guard working — so the order is not a preference.
    const { job, seen } = makeJob({ avatar: FILE_ID });

    await job.run(NOW);

    assert.ok(seen.order.indexOf('delete:profile') < seen.order.indexOf('file:remove'));
    assert.deepEqual(seen.releasedFiles, [FILE_ID]);
  });

  it('reads the avatar before deleting the row that points at it', async () => {
    const { job, seen } = makeJob({ avatar: FILE_ID });

    await job.run(NOW);

    assert.ok(seen.order.indexOf('profile:read') < seen.order.indexOf('delete:profile'));
  });

  it('touches no file when the account had no avatar', async () => {
    const { job, seen } = makeJob({ avatar: null });

    await job.run(NOW);

    assert.ok(!seen.order.includes('file:remove'));
    assert.equal(seen.published[0]!.input.data.avatarReleased, false);
  });

  it('completes the erasure even when the avatar will not release', async () => {
    // The personal data is already gone; an orphaned object is a bounded storage
    // cost, and retrying the whole account for it would re-run the deletes.
    const { job, seen } = makeJob({ avatar: FILE_ID, avatarFails: true });

    const result = await job.run(NOW);

    assert.equal(result.erased, 1);
    assert.equal(result.failed, 0);
    assert.ok(seen.order.includes('ledger:markErased'));
  });

  it('emits the audit event in the transaction that closes the request', async () => {
    const { job, seen } = makeJob();

    await job.run(NOW);

    const [event] = seen.published;
    assert.equal(event?.input.type, 'user.account.erased');
    assert.equal(event?.input.classification, 'audit');
    assert.equal(event?.tx, TX);
  });

  it('reports counts, never contents', async () => {
    // This event outlives the data it describes. It has to say what went without
    // becoming a copy of it (doc 05 §5).
    const { job, seen } = makeJob({ avatar: FILE_ID });

    await job.run(NOW);

    assert.deepEqual(seen.published[0]!.input.data, {
      userId: USER_ID,
      emergencyContacts: 3,
      savedPlaces: 2,
      profile: 1,
      avatarReleased: true,
    });
  });

  it('emits no event when another runner already closed the request', async () => {
    // One erasure, one audit record. A second would make a single irreversible
    // act look like two.
    const { job, seen } = makeJob({ alreadyClosed: true });

    await job.run(NOW);

    assert.deepEqual(seen.published, []);
  });

  describe('refusals', () => {
    it('holds back an account with an open obligation', async () => {
      // Thirty days passed. A dispute can be opened about a ride taken before the
      // account closed, and erasing the identity mid-dispute destroys the other
      // side's evidence.
      const { job, seen } = makeJob({ obligations: [{ module: 'support', code: 'DISPUTE_OPEN' }] });

      const result = await job.run(NOW);

      assert.equal(result.blocked, 1);
      assert.equal(result.erased, 0);
      assert.ok(!seen.order.includes('identity:anonymize'), 'nothing was touched');
      assert.deepEqual(seen.published, [], 'and nothing was audited');
    });

    it('leaves a blocked request open for the next run', async () => {
      const { job, seen } = makeJob({ obligations: [{ module: 'wallet', code: 'BALANCE_OPEN' }] });

      await job.run(NOW);

      assert.ok(!seen.order.includes('ledger:markErased'));
    });

    it('does nothing at all when another runner holds the lock', async () => {
      // Two transactions erasing one account would both find rows to delete, and
      // the loser would emit a second `user.account.erased` for one erasure.
      const { job, seen } = makeJob({ lockHeld: true });

      const result = await job.run(NOW);

      assert.deepEqual(result, { ran: false, scanned: 0, erased: 0, blocked: 0, failed: 0 });
      assert.deepEqual(seen.order, [], 'the ledger was not even read');
    });

    it('releases the lock when the batch finishes', async () => {
      const { job, seen } = makeJob();

      await job.run(NOW);

      assert.equal(seen.order.at(-1), 'lock:release');
    });
  });

  it('reports an empty run without erasing anything', async () => {
    const { job } = makeJob({ due: [] });

    assert.deepEqual(await job.run(NOW), {
      ran: true,
      scanned: 0,
      erased: 0,
      blocked: 0,
      failed: 0,
    });
  });
});
