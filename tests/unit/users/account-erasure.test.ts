import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';
import type { PublishInput } from '../../../src/core/events/index.js';
import { AccountErasureJob } from '../../../src/modules/users/jobs/account-erasure.job.js';

const USER_ID = '00000000-0000-7000-8000-000000000001';
const REQUEST_ID = '00000000-0000-7000-8000-0000000000a1';
const FILE_ID = '00000000-0000-7000-8000-0000000000f1';
const PHONE = '+919876543210';
const NOW = new Date('2026-09-03T03:30:00.000Z');

const TX = { $sentinel: 'tx' } as unknown as TransactionClient;

interface Options {
  due?: { id: string; userId: string }[];
  requestInTx?: { id: string; userId: string; status: string } | null;
  user?: { id: string; status: string; phoneNumber: string; deletedAt: Date | null } | null;
  obligations?: { module: string; code: string }[];
  avatar?: string | null;
  lockHeld?: boolean;
  alreadyClosed?: boolean;
  avatarFails?: boolean;
}

function makeJob(opts: Options = {}) {
  const seen = {
    order: [] as string[],

    published: [] as { input: PublishInput; tx: TransactionClient | undefined }[],
    anonymized: [] as { userId: string; at: Date; joinedTx: boolean }[],
    releasedFiles: [] as string[],
    deadLettered: [] as string[],
  };

  const step = (name: string, tx?: TransactionClient) =>
    seen.order.push(tx === TX ? name : `${name}:OUTSIDE_TX`);

  const deletionRequestRepository = {
    findDue: async () => {
      seen.order.push('ledger:findDue');
      return opts.due ?? [{ id: REQUEST_ID, userId: USER_ID }];
    },
    findById: async (_id: string, tx?: TransactionClient) => {
      step('ledger:reRead', tx);
      return opts.requestInTx === undefined
        ? { id: REQUEST_ID, userId: USER_ID, status: 'PENDING' }
        : opts.requestInTx;
    },
    markErased: async (_id: string, _at: Date, tx?: TransactionClient) => {
      step('ledger:markErased', tx);
      return !opts.alreadyClosed;
    },
  };

  const obligationsRepository = {
    findOpenObligations: async (_userId: string, tx?: TransactionClient) => {
      step('obligations', tx);
      return opts.obligations ?? [];
    },
  };

  const userProfileRepository = {
    findByUserId: async (_userId: string, tx?: TransactionClient) => {
      step('profile:read', tx);
      return opts.avatar === undefined ? null : { profileImageFileId: opts.avatar };
    },
    deleteForUser: async (_userId: string, tx?: TransactionClient) => {
      step('delete:profile', tx);
      return 1;
    },
  };

  const emergencyContactRepository = {
    deleteAllForUser: async (_userId: string, tx?: TransactionClient) => {
      step('delete:contacts', tx);
      return 3;
    },
  };

  const savedPlaceRepository = {
    deleteAllForUser: async (_userId: string, tx?: TransactionClient) => {
      step('delete:places', tx);
      return 2;
    },
  };

  const userRepository = {
    lockForUpdate: async (_userId: string, tx?: TransactionClient) => {
      step('lock', tx);
    },
    findById: async (_userId: string, tx?: TransactionClient) => {
      step('identity:read', tx);
      return opts.user === undefined
        ? { id: USER_ID, status: 'DEACTIVATED', phoneNumber: PHONE, deletedAt: null }
        : opts.user;
    },
    anonymize: async (userId: string, at: Date, tx?: TransactionClient) => {
      step('identity:anonymize', tx);
      seen.anonymized.push({ userId, at, joinedTx: tx === TX });
    },
  };

  const sessionRepository = {
    anonymizeForUser: async (_userId: string, tx?: TransactionClient) => {
      step('anonymize:sessions', tx);
      return 4;
    },
  };

  const deviceRepository = {
    anonymizeForUser: async (_userId: string, tx?: TransactionClient) => {
      step('anonymize:devices', tx);
      return 2;
    },
  };

  const otpRepository = {
    deleteForUser: async (_userId: string, _phone: string, tx?: TransactionClient) => {
      step('delete:otp', tx);
      return 7;
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
    provider: {
      client: {
        hset: async (_key: string, field: string) => {
          seen.deadLettered.push(field);
          return 1;
        },
        hdel: async () => 1,
        hgetall: async () => ({}),
      },
    },
  };

  const userMetrics = {
    accountsErased: () => seen.order.push('metric:erased'),
    erasureBlocked: () => seen.order.push('metric:blocked'),
    avatarReleaseFailed: () => seen.order.push('metric:avatar_failed'),
  };

  const job = new AccountErasureJob(
    deletionRequestRepository as never,
    obligationsRepository as never,
    userProfileRepository as never,
    emergencyContactRepository as never,
    savedPlaceRepository as never,
    userRepository as never,
    sessionRepository as never,
    deviceRepository as never,
    otpRepository as never,
    fileService as never,
    transactionManager as never,
    eventPublisher as never,
    redisService as never,
    userMetrics as never,
  );

  return { job, seen };
}

describe('AccountErasureJob (unit)', () => {
  it('erases the personal data inside one transaction', async () => {
    const { job, seen } = makeJob();

    await job.run(NOW);

    assert.ok(!seen.order.some((s) => s.endsWith('OUTSIDE_TX')), seen.order.join(' → '));
    for (const s of ['delete:contacts', 'delete:places', 'delete:profile']) {
      assert.ok(seen.order.includes(s), s);
    }
  });

  it('anonymizes the identity rather than deleting the row', async () => {
    const { job, seen } = makeJob();

    await job.run(NOW);

    assert.deepEqual(seen.anonymized, [{ userId: USER_ID, at: NOW, joinedTx: true }]);
  });

  describe('state is verified inside the destruction transaction', () => {
    it('locks the user row before it reads anything it will act on', async () => {
      const { job, seen } = makeJob();
      await job.run(NOW);

      const begin = seen.order.indexOf('tx:begin');
      assert.equal(seen.order[begin + 1], 'lock', 'the lock is the first thing in the transaction');
      for (const read of ['ledger:reRead', 'identity:read', 'obligations']) {
        assert.ok(seen.order.indexOf('lock') < seen.order.indexOf(read), read);
      }
    });

    it('re-reads the request inside the transaction, not just in the batch query', async () => {
      const { job, seen } = makeJob();
      await job.run(NOW);

      assert.ok(seen.order.includes('ledger:reRead'));
      assert.ok(!seen.order.includes('ledger:reRead:OUTSIDE_TX'));
    });

    it('destroys nothing when the request was cancelled after it was queued', async () => {
      const { job, seen } = makeJob({
        requestInTx: { id: REQUEST_ID, userId: USER_ID, status: 'CANCELLED' },
      });

      const result = await job.run(NOW);

      assert.equal(result.erased, 0);
      assert.ok(!seen.order.includes('identity:anonymize'), 'the account survives');
      assert.ok(!seen.order.includes('delete:contacts'), 'and so does its data');
      assert.deepEqual(seen.published, [], 'nothing was audited');
    });

    it('destroys nothing when the account was restored to ACTIVE', async () => {
      const { job, seen } = makeJob({
        user: { id: USER_ID, status: 'ACTIVE', phoneNumber: PHONE, deletedAt: null },
      });

      const result = await job.run(NOW);

      assert.equal(result.erased, 0);
      assert.ok(!seen.order.includes('identity:anonymize'));
    });

    it('skips an account that is already erased', async () => {
      const { job, seen } = makeJob({
        user: { id: USER_ID, status: 'DEACTIVATED', phoneNumber: PHONE, deletedAt: NOW },
      });

      const result = await job.run(NOW);

      assert.equal(result.erased, 0);
      assert.ok(!seen.order.includes('identity:anonymize'), 'no second erasure');
      assert.deepEqual(seen.published, [], 'and no second audit event');
    });

    it('rolls the whole scrub back rather than committing an unrecorded erasure', async () => {
      const { job, seen } = makeJob({ alreadyClosed: true });

      const result = await job.run(NOW);

      assert.equal(result.failed, 1, 'the run reports a failure rather than a success');
      assert.equal(result.erased, 0);
      assert.ok(!seen.order.includes('tx:commit'), 'the transaction never committed');
    });

    it('checks obligations inside the transaction too', async () => {
      const { job, seen } = makeJob({ obligations: [{ module: 'rides', code: 'RIDE_OPEN' }] });
      await job.run(NOW);

      assert.ok(seen.order.includes('obligations'));
      assert.ok(!seen.order.includes('obligations:OUTSIDE_TX'));
    });
  });

  describe('erasure completeness', () => {
    it('deletes the OTP trail, which is keyed by the phone number itself', async () => {
      const { job, seen } = makeJob();
      await job.run(NOW);

      assert.ok(seen.order.includes('delete:otp'));
      assert.ok(!seen.order.includes('delete:otp:OUTSIDE_TX'));
    });

    it('anonymizes sessions and devices rather than deleting them', async () => {
      const { job, seen } = makeJob();
      await job.run(NOW);

      assert.ok(seen.order.includes('anonymize:sessions'));
      assert.ok(seen.order.includes('anonymize:devices'));
    });

    it('reports counts, never contents', async () => {
      const { job, seen } = makeJob({ avatar: FILE_ID });

      await job.run(NOW);

      assert.deepEqual(seen.published[0]!.input.data, {
        userId: USER_ID,
        emergencyContacts: 3,
        savedPlaces: 2,
        profile: 1,
        sessions: 4,
        devices: 2,
        otpAttempts: 7,
        avatarReleased: true,
      });
    });

    it('keeps the phone number out of the audit event', async () => {
      const { job, seen } = makeJob();
      await job.run(NOW);

      assert.ok(!JSON.stringify(seen.published).includes(PHONE));
    });
  });

  it('releases the avatar only after the profile that references it is gone', async () => {
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

  it('releases the object only after the erasure has committed', async () => {
    const { job, seen } = makeJob({ avatar: FILE_ID });

    await job.run(NOW);

    assert.ok(seen.order.indexOf('tx:commit') < seen.order.indexOf('file:remove'));
  });

  it('touches no file when the account had no avatar', async () => {
    const { job, seen } = makeJob({ avatar: null });

    await job.run(NOW);

    assert.ok(!seen.order.includes('file:remove'));
    assert.equal(seen.published[0]!.input.data.avatarReleased, false);
  });

  describe('when the avatar will not release', () => {
    it('still completes the erasure', async () => {
      const { job, seen } = makeJob({ avatar: FILE_ID, avatarFails: true });

      const result = await job.run(NOW);

      assert.equal(result.erased, 1);
      assert.equal(result.failed, 0);
      assert.ok(seen.order.includes('ledger:markErased'));
    });

    it('dead-letters the object instead of swallowing the failure', async () => {
      const { job, seen } = makeJob({ avatar: FILE_ID, avatarFails: true });

      const result = await job.run(NOW);

      assert.equal(result.avatarsStranded, 1, 'the run reports it');
      assert.deepEqual(seen.deadLettered, [USER_ID], 'and an operator can find it');
      assert.ok(seen.order.includes('metric:avatar_failed'), 'and it is alertable');
    });

    it('lists what is stranded', async () => {
      const { job } = makeJob({ avatar: FILE_ID, avatarFails: true });
      await job.run(NOW);

      assert.deepEqual(await job.strandedAvatars(), []);
    });
  });

  it('emits the audit event in the transaction that closes the request', async () => {
    const { job, seen } = makeJob();

    await job.run(NOW);

    const [event] = seen.published;
    assert.equal(event?.input.type, 'user.account.erased');
    assert.equal(event?.input.classification, 'audit');
    assert.equal(event?.tx, TX);
  });

  it('closes the ledger with the scrub, so the two can never disagree', async () => {
    const { job, seen } = makeJob();

    await job.run(NOW);

    const anonymized = seen.order.indexOf('identity:anonymize');
    const closed = seen.order.indexOf('ledger:markErased');
    const committed = seen.order.indexOf('tx:commit');
    assert.ok(anonymized < closed, 'the data goes before the ledger records that it went');
    assert.ok(closed < committed, 'and both land in the same commit');
  });

  describe('refusals', () => {
    it('holds back an account with an open obligation', async () => {
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
      const { job, seen } = makeJob({ lockHeld: true });

      const result = await job.run(NOW);

      assert.deepEqual(result, {
        ran: false,
        scanned: 0,
        erased: 0,
        blocked: 0,
        failed: 0,
        avatarsStranded: 0,
      });
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
      avatarsStranded: 0,
    });
  });
});
