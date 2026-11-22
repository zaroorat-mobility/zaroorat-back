import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SessionService } from '../../../src/modules/auth/services/session/session.service.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;

function makeService(opts: { revokeWon?: boolean } = {}) {
  const seen = {
    executeCalls: 0,
    revokeTx: undefined as unknown,
    familyTx: undefined as unknown,
    publishTx: undefined as unknown,
    denylistRevoked: 0,
    published: [] as PublishInput[],
    order: [] as string[],
  };

  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => {
      seen.executeCalls += 1;
      return cb(TX);
    },
  };
  const sessionRepository = {
    revoke: async (_id: string, _reason: string, _at: unknown, tx: TransactionClient) => {
      seen.revokeTx = tx;
      seen.order.push('revoke');
      return opts.revokeWon ?? true;
    },
    findById: async () => ({ id: 's1', userId: 'u1' }),
  };
  const refreshTokenRepository = {
    revokeBySession: async (_sid: string, _reason: string, _at: unknown, tx: TransactionClient) => {
      seen.familyTx = tx;
      seen.order.push('family');
      return 1;
    },
  };
  const redisService = {
    sidBlacklist: {
      revoke: async () => {
        seen.denylistRevoked += 1;
        seen.order.push('denylist');
      },
    },
  };
  const epochService = { bump: async () => {} };
  const sessionMetrics = { revoked: () => {}, capEvicted: () => {} };
  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.publishTx = tx;
      seen.published.push(input);
      seen.order.push('publish');
    },
  };
  const sessionConfig = { denylistTtlSeconds: 60, maxConcurrentSessions: 5 };

  const service = new SessionService(
    sessionRepository as never,
    refreshTokenRepository as never,

    { lockForUpdate: async () => undefined } as never,
    redisService as never,
    epochService as never,
    sessionMetrics as never,
    eventPublisher as never,
    transactionManager as never,
    sessionConfig as never,
  );
  return { service, seen };
}

describe('SessionService revoke — unit of work', () => {
  it('threads a single tx through the revoke, the family revoke, and the audit event', async () => {
    const { service, seen } = makeService({ revokeWon: true });
    await service.logout('s1');

    assert.equal(seen.executeCalls, 1);
    assert.equal(seen.revokeTx, TX);
    assert.equal(seen.familyTx, TX);
    assert.equal(seen.publishTx, TX, 'the audit event must enqueue in the same tx');
    assert.equal(seen.published[0]?.type, 'auth.session.revoked');
  });

  it('runs the denylist + metrics only AFTER the transaction commits', async () => {
    const { service, seen } = makeService({ revokeWon: true });
    await service.logout('s1');

    assert.deepEqual(seen.order, ['revoke', 'family', 'publish', 'denylist']);
    assert.equal(seen.denylistRevoked, 1);
  });

  it('does nothing outside the tx when the conditional revoke did not win', async () => {
    const { service, seen } = makeService({ revokeWon: false });
    await service.logout('s1');

    assert.equal(seen.familyTx, undefined, 'lost race: no family revoke');
    assert.equal(seen.published.length, 0, 'lost race: no event');
    assert.equal(seen.denylistRevoked, 0, 'lost race: no denylist write');
  });
});
