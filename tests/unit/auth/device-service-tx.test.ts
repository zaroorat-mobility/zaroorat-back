import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DeviceService } from '../../../src/modules/auth/session/device.service.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;

function makeService() {
  const seen = {
    trustTx: undefined as unknown,
    publishTx: undefined as unknown,
    published: [] as PublishInput[],
    sessionsRevoked: 0,
    order: [] as string[],
  };

  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => cb(TX),
  };
  const deviceRepository = {
    updateTrustState: async (_id: string, _state: string, tx: TransactionClient) => {
      seen.trustTx = tx;
      seen.order.push('trust');
      return { id: 'dev-1', userId: 'u1' };
    },
  };
  const sessionService = {
    revokeDeviceSessions: async () => {
      seen.sessionsRevoked += 1;
      seen.order.push('sessions');
      return 3;
    },
  };
  const sessionMetrics = { deviceRevoked: () => {} };
  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.publishTx = tx;
      seen.published.push(input);
      seen.order.push('publish');
    },
  };

  const service = new DeviceService(
    deviceRepository as never,
    sessionService as never,
    sessionMetrics as never,
    eventPublisher as never,
    transactionManager as never,
  );
  return { service, seen };
}

// Proves the UoW guarantee for device trust transitions: the trust-state write
// and its audit event commit in one tx; session revocation (itself atomic) runs
// only after the device is durably revoked.
describe('DeviceService — unit of work', () => {
  it('markSuspicious writes the state and auth.device.flagged in the same tx', async () => {
    const { service, seen } = makeService();
    await service.markSuspicious('dev-1');

    assert.equal(seen.trustTx, TX);
    assert.equal(seen.publishTx, TX);
    assert.equal(seen.published[0]?.type, 'auth.device.flagged');
  });

  it('revoke commits state + auth.device.revoked atomically, then revokes sessions', async () => {
    const { service, seen } = makeService();
    const revoked = await service.revoke('dev-1');

    assert.equal(seen.trustTx, TX);
    assert.equal(seen.publishTx, TX);
    assert.equal(seen.published[0]?.type, 'auth.device.revoked');
    assert.equal(revoked, 3);
    // The device + event commit before the (separately atomic) session revokes.
    assert.deepEqual(seen.order, ['trust', 'publish', 'sessions']);
  });
});
