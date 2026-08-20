import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SessionService } from '../../../src/modules/auth/services/session/session.service.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;

function makeService(activeSessionIds: string[]) {
  const seen = {
    revokeAllTx: undefined as unknown,
    tokenRevokeAllTx: undefined as unknown,
    published: [] as { input: PublishInput; tx: unknown }[],
    epochBumped: 0,
    order: [] as string[],
  };

  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => cb(TX),
  };
  const sessionRepository = {
    findActiveByUser: async () => activeSessionIds.map((id) => ({ id })),
    revokeAllByUser: async (_u: string, _r: string, _at: unknown, tx: TransactionClient) => {
      seen.revokeAllTx = tx;
      seen.order.push('revokeSessions');
      return activeSessionIds.length;
    },
  };
  const refreshTokenRepository = {
    revokeAllByUser: async (_u: string, _r: string, _at: unknown, tx: TransactionClient) => {
      seen.tokenRevokeAllTx = tx;
      seen.order.push('revokeTokens');
      return activeSessionIds.length;
    },
  };
  const redisService = { sidBlacklist: { revoke: async () => {} } };
  const epochService = {
    bump: async () => {
      seen.epochBumped += 1;
      seen.order.push('epoch');
    },
  };
  const sessionMetrics = { logoutAll: () => {}, revoked: () => {}, capEvicted: () => {} };
  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.published.push({ input, tx });
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

describe('SessionService.logoutAll — per-sid events', () => {
  it('emits one session.revoked per active session, all in the revoke transaction', async () => {
    const { service, seen } = makeService(['s1', 's2', 's3']);
    await service.logoutAll('u1', 'suspension');

    assert.equal(seen.published.length, 3);
    assert.deepEqual(seen.published.map((p) => p.input.data?.sessionId).sort(), ['s1', 's2', 's3']);
    for (const p of seen.published) {
      assert.equal(p.input.type, 'auth.session.revoked');
      assert.equal(p.input.data?.reason, 'suspension');
      assert.equal(p.tx, TX, 'each event must enqueue in the revoke transaction');
    }
    assert.equal(seen.revokeAllTx, TX);
    assert.equal(seen.tokenRevokeAllTx, TX);
  });

  it('bumps the epoch only after the transaction commits', async () => {
    const { service, seen } = makeService(['s1', 's2']);
    await service.logoutAll('u1');

    assert.deepEqual(seen.order, ['revokeSessions', 'revokeTokens', 'publish', 'publish', 'epoch']);
    assert.equal(seen.epochBumped, 1);
  });

  it('still revokes + bumps epoch when the user has no active sessions (no events)', async () => {
    const { service, seen } = makeService([]);
    await service.logoutAll('u1');

    assert.equal(seen.published.length, 0);
    assert.equal(seen.epochBumped, 1);
    assert.equal(seen.revokeAllTx, TX);
  });
});
