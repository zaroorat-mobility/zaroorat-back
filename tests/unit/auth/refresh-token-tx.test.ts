import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RefreshTokenService } from '../../../src/modules/auth/services/refresh-token.service.js';
import { TokenReuseError } from '../../../src/modules/auth/errors.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';
import { makeJwtConfig } from '../../helpers/config.js';

const TX = { __tx: true } as unknown as TransactionClient;

// Proves the UoW guarantee for refresh-token reuse: the family revoke and the
// auth.refresh.reuse_detected audit event commit in one transaction, the epoch
// bump follows after commit, and TokenReuseError is thrown (AUTH-INV-5).
describe('RefreshTokenService reuse — unit of work', () => {
  function makeService() {
    const seen = {
      familyTx: undefined as unknown,
      publishTx: undefined as unknown,
      published: [] as PublishInput[],
      epochBumped: 0,
      order: [] as string[],
    };

    const transactionManager = {
      execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => cb(TX),
    };
    const refreshTokenRepository = {
      // A revoked row → this presented token is a replay of a consumed token.
      findByHash: async () => ({
        id: 't-old',
        userId: 'u1',
        sessionId: 's1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
      revokeBySession: async (
        _sid: string,
        _reason: string,
        _at: unknown,
        tx: TransactionClient,
      ) => {
        seen.familyTx = tx;
        seen.order.push('family');
        return 2;
      },
    };
    const epochService = {
      bump: async () => {
        seen.epochBumped += 1;
        seen.order.push('epoch');
      },
    };
    const eventPublisher = {
      publish: async (input: PublishInput, tx?: TransactionClient) => {
        seen.publishTx = tx;
        seen.published.push(input);
        seen.order.push('publish');
      },
    };

    const service = new RefreshTokenService(
      refreshTokenRepository as never,
      epochService as never,
      eventPublisher as never,
      transactionManager as never,
      makeJwtConfig(),
    );
    return { service, seen };
  }

  it('revokes the family and writes the audit event in the same tx, bumps epoch after', async () => {
    const { service, seen } = makeService();

    await assert.rejects(() => service.rotate('some-replayed-token'), TokenReuseError);

    assert.equal(seen.familyTx, TX);
    assert.equal(seen.publishTx, TX, 'reuse_detected must enqueue in the same tx');
    assert.equal(seen.published[0]?.type, 'auth.refresh.reuse_detected');
    assert.equal(seen.epochBumped, 1);
    // Family + event are transactional; the epoch bump (Redis) is strictly after.
    assert.deepEqual(seen.order, ['family', 'publish', 'epoch']);
  });
});
