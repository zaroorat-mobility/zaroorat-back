import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IdempotencyInFlightError,
  IdempotencyStore,
} from '../../../src/core/cache/stores/IdempotencyStore.js';
import { IDEMPOTENCY_OPERATIONS } from '../../../src/core/cache/keys.js';

function makeStore() {
  const keys = new Map<string, string>();
  const calls = { set: 0, get: 0, del: 0 };

  const client = {
    async set(key: string, value: string, _ex: string, _ttl: number, nx?: string) {
      calls.set += 1;
      if (nx === 'NX' && keys.has(key)) return null;
      keys.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      calls.get += 1;
      return keys.get(key) ?? null;
    },
    async del(key: string) {
      calls.del += 1;
      keys.delete(key);
      return 1;
    },
  };

  const store = new IdempotencyStore({ client } as never);
  return { store, keys, calls };
}

const OP = IDEMPOTENCY_OPERATIONS.OTP_VERIFY;

describe('IdempotencyStore.runOnce', () => {
  it('executes the operation once and returns its result', async () => {
    const { store } = makeStore();
    let runs = 0;

    const result = await store.runOnce(OP, 'k1', 60, async () => {
      runs += 1;
      return { token: 'abc' };
    });

    assert.deepEqual(result, { token: 'abc' });
    assert.equal(runs, 1);
  });

  it('runs the operation exactly once when N requests share a key', async () => {
    const { store } = makeStore();
    let runs = 0;

    const operation = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'result';
    };

    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => store.runOnce(OP, 'k2', 60, operation)),
    );

    assert.equal(runs, 1, 'the business operation must not run twice');

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'one winner');
    assert.equal(rejected.length, 7, 'and the rest are told to retry');
    for (const outcome of rejected) {
      assert.ok((outcome as PromiseRejectedResult).reason instanceof IdempotencyInFlightError);
    }
  });

  it('replays the stored result once the first request has finished', async () => {
    const { store } = makeStore();
    let runs = 0;
    const operation = async () => {
      runs += 1;
      return { pair: runs };
    };

    const first = await store.runOnce(OP, 'k3', 60, operation);
    const second = await store.runOnce(OP, 'k3', 60, operation);

    assert.deepEqual(second, first, 'the retry gets the original answer');
    assert.equal(runs, 1, 'and the operation still ran only once');
  });

  it('reports an in-flight duplicate as IdempotencyInFlightError, not as a replay', async () => {
    const { store } = makeStore();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = store.runOnce(OP, 'k4', 60, async () => {
      await blocked;
      return 'done';
    });

    await assert.rejects(
      () => store.runOnce(OP, 'k4', 60, async () => 'second'),
      IdempotencyInFlightError,
    );

    release?.();
    assert.equal(await first, 'done');
  });

  it('carries a 409-shaped code the modules can map', async () => {
    assert.equal(new IdempotencyInFlightError().code, 'IDEMPOTENCY_IN_PROGRESS');
  });

  it('releases the claim when the operation fails, so a retry can proceed', async () => {
    const { store, keys } = makeStore();
    let attempts = 0;

    await assert.rejects(
      () =>
        store.runOnce(OP, 'k5', 60, async () => {
          attempts += 1;
          throw new Error('database is down');
        }),
      /database is down/,
    );
    assert.equal(keys.size, 0, 'the claim was dropped');

    const recovered = await store.runOnce(OP, 'k5', 60, async () => {
      attempts += 1;
      return 'ok';
    });
    assert.equal(recovered, 'ok');
    assert.equal(attempts, 2, 'the retry actually executed');
  });

  it('claims with a single SET NX rather than a read followed by a write', async () => {
    const { store, calls } = makeStore();
    await store.runOnce(OP, 'k6', 60, async () => 'v');

    assert.equal(calls.get, 0, 'the happy path never reads before claiming');
    assert.equal(calls.set, 2, 'one claim, one result write');
  });

  it('keeps keys independent', async () => {
    const { store } = makeStore();
    let runs = 0;
    const operation = async () => {
      runs += 1;
      return runs;
    };

    await store.runOnce(OP, 'a', 60, operation);
    await store.runOnce(OP, 'b', 60, operation);

    assert.equal(runs, 2, 'a claim on one key must not block another');
  });
});
