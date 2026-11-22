import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RefreshTokenService } from '../../../src/modules/auth/services/token/refresh-token.service.js';
import {
  TokenInvalidError,
  TokenReuseError,
} from '../../../src/modules/auth/errors/auth.errors.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;
const USER_ID = '00000000-0000-7000-8000-000000000001';
const SESSION_ID = '00000000-0000-7000-8000-0000000000a1';

interface Row {
  id: string;
  userId: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

function makeService(opts: { revoked?: boolean; expired?: boolean } = {}) {
  const rows = new Map<string, Row>();
  const seen = { order: [] as string[], published: [] as PublishInput[], epochBumps: 0 };

  const live: Row = {
    id: 'tok-1',
    userId: USER_ID,
    sessionId: SESSION_ID,
    tokenHash: 'set-below',
    expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 86_400_000)),
    revokedAt: opts.revoked ? new Date() : null,
  };

  const refreshTokenRepository = {
    findByHash: async (hash: string, tx?: TransactionClient) => {
      seen.order.push(tx === TX ? 'read' : 'read:OUTSIDE_TX');
      return live.tokenHash === hash ? live : null;
    },
    claimForRotation: async (id: string, tx: TransactionClient) => {
      seen.order.push(tx === TX ? 'claim' : 'claim:OUTSIDE_TX');
      const row = id === live.id ? live : null;

      if (!row || row.revokedAt !== null) return false;
      row.revokedAt = new Date();
      return true;
    },
    create: async (input: Record<string, unknown>, tx?: TransactionClient) => {
      seen.order.push(tx === TX ? 'create' : 'create:OUTSIDE_TX');
      const created: Row = {
        id: `tok-${rows.size + 2}`,
        userId: input.userId as string,
        sessionId: input.sessionId as string,
        tokenHash: input.tokenHash as string,
        expiresAt: input.expiresAt as Date,
        revokedAt: null,
      };
      rows.set(created.id, created);
      return created;
    },
    linkRotation: async (_id: string, _to: string, tx: TransactionClient) => {
      seen.order.push(tx === TX ? 'link' : 'link:OUTSIDE_TX');
    },
    revokeBySession: async (_sessionId: string, reason: string) => {
      seen.order.push(`revokeFamily:${reason}`);
      return 1;
    },
  };

  const service = new RefreshTokenService(
    refreshTokenRepository as never,
    {
      bump: async () => {
        seen.order.push('epoch:bump');
        seen.epochBumps += 1;
        return 2;
      },
    } as never,
    {
      publish: async (input: PublishInput) => {
        seen.published.push(input);
        seen.order.push(`publish:${input.type}`);
      },
    } as never,
    {
      execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => {
        seen.order.push('tx:begin');
        const out = await cb(TX);
        seen.order.push('tx:commit');
        return out;
      },
    } as never,
    { refreshSecret: 'test-pepper', refreshTtlSeconds: 2_592_000 } as never,
  );

  const RAW = 'raw-refresh-token';
  live.tokenHash = (service as unknown as { hash(t: string): string }).hash(RAW);

  return { service, seen, live, rows, RAW };
}

describe('RefreshTokenService.rotate — atomic claim', () => {
  it('rotates once, inside one transaction, claiming before it creates', async () => {
    const { service, seen, RAW } = makeService();
    const result = await service.rotate(RAW);

    assert.equal(result.userId, USER_ID);
    assert.equal(result.sessionId, SESSION_ID);
    assert.ok(result.refresh.token, 'a successor token was returned');

    assert.deepEqual(seen.order.slice(0, 6), [
      'tx:begin',
      'read',
      'claim',
      'create',
      'link',
      'tx:commit',
    ]);
    assert.ok(
      !seen.order.some((step) => step.endsWith('OUTSIDE_TX')),
      'nothing that decides the rotation may run on the pooled client',
    );
  });

  it('claims before creating, so a loser leaves no successor behind', async () => {
    const { service, seen, RAW } = makeService();
    await service.rotate(RAW);
    assert.ok(seen.order.indexOf('claim') < seen.order.indexOf('create'));
  });

  it('lets exactly one of two concurrent rotations of the same token succeed', async () => {
    const { service, seen, rows, RAW } = makeService();

    const settled = await Promise.allSettled([service.rotate(RAW), service.rotate(RAW)]);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'exactly one winner');
    assert.equal(rejected.length, 1, 'exactly one loser');
    assert.ok(
      (rejected[0] as PromiseRejectedResult).reason instanceof TokenReuseError,
      'the loser is treated as reuse, not as a second success',
    );

    assert.equal(rows.size, 1, 'one refresh token in, one refresh token out');
    assert.equal(seen.epochBumps, 1, 'and the family was invalidated exactly once');
  });

  it('never leaves two live successors, however many callers race', async () => {
    const { service, rows, RAW } = makeService();

    await Promise.allSettled(Array.from({ length: 6 }, () => service.rotate(RAW)));

    const live = [...rows.values()].filter((row) => row.revokedAt === null);
    assert.equal(live.length, 1, `expected one live successor, found ${live.length}`);
  });

  it('sends the loser down the existing reuse path: family revoked, epoch bumped', async () => {
    const { service, seen, RAW } = makeService();
    await Promise.allSettled([service.rotate(RAW), service.rotate(RAW)]);

    assert.ok(
      seen.order.includes('revokeFamily:reuse_detected'),
      'the whole family is revoked, exactly as a replayed token would',
    );
    assert.ok(seen.order.includes('epoch:bump'), 'and outstanding access tokens are invalidated');
    const reuse = seen.published.find((e) => e.type === 'auth.refresh.reuse_detected');
    assert.deepEqual(reuse?.data, { userId: USER_ID, sessionId: SESSION_ID });
  });

  it('bumps the epoch only after the revocation transaction commits', async () => {
    const { service, seen, RAW } = makeService({ revoked: true });
    await assert.rejects(() => service.rotate(RAW), TokenReuseError);

    assert.ok(seen.order.lastIndexOf('tx:commit') < seen.order.indexOf('epoch:bump'));
  });

  it('still detects a plainly replayed token', async () => {
    const { service, seen, RAW } = makeService({ revoked: true });
    await assert.rejects(() => service.rotate(RAW), TokenReuseError);

    assert.ok(seen.order.includes('revokeFamily:reuse_detected'));
    assert.ok(!seen.order.includes('create'), 'and mints nothing');
  });

  it('rejects an unknown token without touching the family', async () => {
    const { service, seen } = makeService();
    await assert.rejects(() => service.rotate('never-issued'), TokenInvalidError);

    assert.equal(seen.epochBumps, 0);
    assert.ok(!seen.order.includes('revokeFamily:reuse_detected'));
  });

  it('rejects an expired token as invalid, not as reuse', async () => {
    const { service, seen, RAW } = makeService({ expired: true });
    await assert.rejects(() => service.rotate(RAW), TokenInvalidError);

    assert.equal(seen.epochBumps, 0);
    assert.ok(!seen.order.includes('claim'), 'expiry short-circuits before the claim');
  });

  it('announces the rotation with its lineage', async () => {
    const { service, seen, RAW } = makeService();
    await service.rotate(RAW);

    const event = seen.published.find((e) => e.type === 'auth.token.refreshed');
    assert.equal(event?.data?.rotatedFrom, 'tok-1');
    assert.ok(event?.data?.rotatedTo, 'and names its successor');
  });

  it('keeps the raw token out of every event payload', async () => {
    const { service, seen, RAW } = makeService();
    const result = await service.rotate(RAW);

    const serialized = JSON.stringify(seen.published);
    assert.ok(!serialized.includes(RAW), 'the presented token must not be announced');
    assert.ok(!serialized.includes(result.refresh.token), 'nor the one just minted');
  });
});
