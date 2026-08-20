import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RefreshTokenService } from '../../../src/modules/auth/services/token/refresh-token.service.js';
import { TokenReuseError } from '../../../src/modules/auth/errors/auth.errors.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';
import { makeJwtConfig } from '../../helpers/config.js';

const TX = { __tx: true } as unknown as TransactionClient;

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

    assert.deepEqual(seen.order, ['family', 'publish', 'epoch']);
  });
});
