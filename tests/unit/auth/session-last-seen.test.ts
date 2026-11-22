import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SessionService } from '../../../src/modules/auth/services/session/session.service.js';

const SID = '00000000-0000-7000-8000-0000000000a1';

function makeService(
  opts: { throttleSeconds?: number; lockThrows?: boolean; writeThrows?: boolean } = {},
) {
  const held = new Set<string>();
  const calls = { writes: 0, acquires: 0, releases: 0, wrote: [] as Date[] };

  const sessionRepository = {
    touchLastSeen: async (_id: string, at: Date) => {
      if (opts.writeThrows) throw new Error('database is down');
      calls.writes += 1;
      calls.wrote.push(at);
    },
  };
  const redisService = {
    lock: {
      acquire: async (resource: string) => {
        calls.acquires += 1;
        if (opts.lockThrows) throw new Error('redis is down');
        if (held.has(resource)) return null;
        held.add(resource);
        return 'token';
      },
      release: async () => {
        calls.releases += 1;
        return true;
      },
    },
  };

  const service = new SessionService(
    sessionRepository as never,
    {} as never,

    {} as never,
    redisService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { lastSeenThrottleSeconds: opts.throttleSeconds ?? 60 } as never,
  );
  return { service, calls, expire: () => held.clear() };
}

describe('SessionService.touchLastSeenThrottled', () => {
  it('writes once per window, however many requests arrive', async () => {
    const { service, calls } = makeService();

    const results = await Promise.all(
      Array.from({ length: 25 }, () => service.touchLastSeenThrottled(SID)),
    );

    assert.equal(calls.writes, 1, 'one database write for twenty-five requests');
    assert.equal(
      results.filter(Boolean).length,
      1,
      'and exactly one caller reports having done it',
    );
    assert.equal(calls.acquires, 25, 'every request still pays the cheap Redis check');
  });

  it('writes again once the window has passed', async () => {
    const { service, calls, expire } = makeService();

    await service.touchLastSeenThrottled(SID);
    expire();
    await service.touchLastSeenThrottled(SID);

    assert.equal(calls.writes, 2);
  });

  it('never releases the gate early — the TTL owns it', async () => {
    const { service, calls } = makeService();
    await service.touchLastSeenThrottled(SID);
    assert.equal(calls.releases, 0);
  });

  it('throttles per session, not globally', async () => {
    const { service, calls } = makeService();
    await service.touchLastSeenThrottled(SID);
    await service.touchLastSeenThrottled('00000000-0000-7000-8000-0000000000b2');

    assert.equal(calls.writes, 2, 'one busy session must not mask another');
  });

  it('writes on every call when the throttle is disabled', async () => {
    const { service, calls } = makeService({ throttleSeconds: 0 });
    await service.touchLastSeenThrottled(SID);
    await service.touchLastSeenThrottled(SID);

    assert.equal(calls.writes, 2);
    assert.equal(calls.acquires, 0, 'and it does not bother Redis at all');
  });

  it('records the instant it was given', async () => {
    const { service, calls } = makeService();
    const at = new Date('2026-08-08T10:30:00.000Z');
    await service.touchLastSeenThrottled(SID, at);

    assert.equal(calls.wrote[0]?.toISOString(), at.toISOString());
  });

  it('survives Redis being down', async () => {
    const { service } = makeService({ lockThrows: true });
    assert.equal(await service.touchLastSeenThrottled(SID), false);
  });

  it('survives the database write failing', async () => {
    const { service } = makeService({ writeThrows: true });
    assert.equal(await service.touchLastSeenThrottled(SID), false);
  });
});
