import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentService } from '../../../src/modules/payments/services/payment.service.js';
import { IdempotencyRepository } from '../../../src/modules/payments/repositories/idempotency.repository.js';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyKeyRequiredError,
} from '../../../src/modules/payments/errors/payment.errors.js';

function fakeRedis() {
  const store = new Map<string, unknown>();
  // Mirrors RedisKeys.idempotency: the operation is part of the key, so this
  // fake cannot accidentally pass a test that the real store would fail.
  const scoped = (operation: string, key: string): string => `idem:${operation}:${key}`;

  const idempotency = {
    async get<T>(operation: string, key: string): Promise<T | null> {
      return (store.get(scoped(operation, key)) as T) ?? null;
    },
    async put(operation: string, key: string, value: unknown): Promise<void> {
      store.set(scoped(operation, key), value);
    },
    async putIfAbsent(operation: string, key: string, value: unknown): Promise<boolean> {
      if (store.has(scoped(operation, key))) return false;
      store.set(scoped(operation, key), value);
      return true;
    },
    async forget(operation: string, key: string): Promise<void> {
      store.delete(scoped(operation, key));
    },
    async runOnce<T>(
      operation: string,
      key: string,
      _ttl: number,
      action: () => Promise<T>,
    ): Promise<T> {
      if (!(await idempotency.putIfAbsent(operation, key, { state: 'in_flight' }))) {
        const record = store.get(scoped(operation, key)) as { state: string; result?: T };
        if (record?.state === 'done') return record.result as T;
        throw new Error('IDEMPOTENCY_IN_PROGRESS');
      }
      try {
        const result = await action();
        store.set(scoped(operation, key), { state: 'done', result });
        return result;
      } catch (err) {
        store.delete(scoped(operation, key));
        throw err;
      }
    },
  };
  return { idempotency };
}

function service(): { svc: PaymentService; effects: string[] } {
  const effects: string[] = [];
  const repo = new IdempotencyRepository(fakeRedis() as never);
  const svc = new PaymentService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    repo,
  );
  return { svc, effects };
}

describe('Payment idempotency', () => {
  it('rejects a money-moving call with no Idempotency-Key', async () => {
    const { svc, effects } = service();

    await assert.rejects(
      () =>
        svc.withIdempotency('user-1', '/refunds', undefined, { amount: 100 }, async () => {
          effects.push('refunded');
          return { ok: true };
        }),
      (err: unknown) => err instanceof IdempotencyKeyRequiredError,
    );
    assert.deepEqual(effects, [], 'no financial effect may occur without a key');
  });

  it('rejects a blank Idempotency-Key', async () => {
    const { svc } = service();
    await assert.rejects(
      () => svc.withIdempotency('user-1', '/refunds', '   ', {}, async () => ({ ok: true })),
      (err: unknown) => err instanceof IdempotencyKeyRequiredError,
    );
  });

  it('replays the original result for the same key and payload', async () => {
    const { svc, effects } = service();
    const payload = { amount: 100, transactionId: 'txn_1' };

    const first = await svc.withIdempotency('user-1', '/refunds', 'key-1', payload, async () => {
      effects.push('refunded');
      return { refundId: 'rf_1' };
    });
    const second = await svc.withIdempotency('user-1', '/refunds', 'key-1', payload, async () => {
      effects.push('refunded');
      return { refundId: 'rf_2' };
    });

    assert.deepEqual(first, { refundId: 'rf_1' });
    assert.deepEqual(second, { refundId: 'rf_1' }, 'retry must replay, not re-execute');
    assert.deepEqual(effects, ['refunded'], 'exactly one financial effect');
  });

  it('rejects the same key used with a different payload', async () => {
    const { svc } = service();

    await svc.withIdempotency('user-1', '/refunds', 'key-2', { amount: 100 }, async () => ({
      refundId: 'rf_1',
    }));

    await assert.rejects(
      () =>
        svc.withIdempotency('user-1', '/refunds', 'key-2', { amount: 999 }, async () => ({
          refundId: 'rf_2',
        })),
      (err: unknown) => err instanceof DuplicateIdempotencyKeyError,
    );
  });

  it('treats a reordered payload as the same payload', async () => {
    const { svc, effects } = service();

    await svc.withIdempotency(
      'user-1',
      '/refunds',
      'key-3',
      { amount: 100, transactionId: 'txn_1' },
      async () => {
        effects.push('refunded');
        return { refundId: 'rf_1' };
      },
    );

    const replay = await svc.withIdempotency(
      'user-1',
      '/refunds',
      'key-3',
      { transactionId: 'txn_1', amount: 100 },
      async () => {
        effects.push('refunded');
        return { refundId: 'rf_2' };
      },
    );

    assert.deepEqual(replay, { refundId: 'rf_1' });
    assert.deepEqual(effects, ['refunded']);
  });

  it('produces exactly one effect for concurrent same-key requests', async () => {
    const { svc, effects } = service();
    const payload = { amount: 100 };

    const attempts = Array.from({ length: 20 }, () =>
      svc.withIdempotency('user-1', '/payouts', 'key-4', payload, async () => {
        effects.push('paid');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { payoutId: 'po_1' };
      }),
    );

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');

    assert.equal(effects.length, 1, 'exactly one payout may execute');
    assert.ok(fulfilled.length >= 1);
  });

  it('scopes keys per user, so one user cannot replay another’s result', async () => {
    const { svc, effects } = service();
    const payload = { amount: 100 };

    await svc.withIdempotency('user-1', '/payouts', 'shared', payload, async () => {
      effects.push('user-1');
      return { payoutId: 'po_1' };
    });
    const other = await svc.withIdempotency('user-2', '/payouts', 'shared', payload, async () => {
      effects.push('user-2');
      return { payoutId: 'po_2' };
    });

    assert.deepEqual(other, { payoutId: 'po_2' });
    assert.deepEqual(effects, ['user-1', 'user-2']);
  });

  it('releases the key when the operation fails, so a retry can succeed', async () => {
    const { svc } = service();

    await assert.rejects(() =>
      svc.withIdempotency('user-1', '/refunds', 'key-5', {}, async () => {
        throw new Error('gateway down');
      }),
    );

    const retry = await svc.withIdempotency('user-1', '/refunds', 'key-5', {}, async () => ({
      refundId: 'rf_ok',
    }));
    assert.deepEqual(retry, { refundId: 'rf_ok' });
  });
});
