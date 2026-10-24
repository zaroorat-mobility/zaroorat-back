import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PaymentService } from '../../../src/modules/payments/services/payment.service.js';
import { IdempotencyRepository } from '../../../src/modules/payments/repositories/idempotency.repository.js';
import {
  DuplicateIdempotencyKeyError,
  IdempotencyKeyRequiredError,
} from '../../../src/modules/payments/errors/payment.errors.js';
import { IntentService } from '../../../src/modules/payments/services/intent/intent.service.js';
import { CommissionWalletController } from '../../../src/modules/payments/controllers/commission-wallet.controller.js';
import { SubscriptionService } from '../../../src/modules/subscriptions/services/subscription.service.js';
import { Decimal } from '../../../src/modules/payments/types/index.js';
import { paymentConfig } from '../../../src/config/index.js';

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

/// 005-razorpay-driver-payments T014 (TM-04): idempotency keys are scoped per
/// driver and purpose (T017). The fakes below share one in-memory intent table,
/// keyed like `payment_intents.idempotency_key` (unique across all users).
describe('Driver-scoped payment idempotency (T014/T017)', () => {
  const OPTION_ID = '0190c3f4-6a3e-7c1d-8a4b-2f6e9d1c0aaa';
  const drivers: Record<string, { id: string; paymentModel: string }> = {
    user_a: { id: 'driver_a', paymentModel: 'COMMISSION' },
    user_b: { id: 'driver_b', paymentModel: 'COMMISSION' },
  };

  function world() {
    const intents = new Map<string, { id: string; userId: string; purpose: string }>();
    const gatewayCalls: string[] = [];
    let seq = 0;
    const intentRepo = {
      async findByIdempotencyKey(key: string) {
        return intents.get(key) ?? null;
      },
      // The controllers rebuild `checkout` from the intent on every answer.
      async findById(id: string) {
        return [...intents.values()].find((row) => row.id === id) ?? null;
      },
      async create(input: { idempotencyKey: string; userId: string; purpose: string }) {
        if (intents.has(input.idempotencyKey)) throw new Error('unique violation');
        const row = {
          ...input,
          id: `intent_${++seq}`,
          status: 'PENDING',
          amount: new Decimal(500),
        };
        intents.set(input.idempotencyKey, row);
        return row;
      },
    };
    const gateway = {
      gatewayName: 'mock',
      async createIntent(input: { idempotencyKey: string }) {
        gatewayCalls.push(input.idempotencyKey);
        return { gatewayIntentId: `order_${gatewayCalls.length}`, status: 'PENDING' };
      },
      // The recharge response's checkout payload (005 T042); the mock has none.
      checkoutKeyId: () => null,
    };
    const gatewayResolver = {
      async getActiveGateway() {
        return gateway;
      },
      async forProviderName() {
        return gateway;
      },
    };
    const intentService = new IntentService(
      intentRepo as never,
      gatewayResolver as never,
      {} as never,
      { execute: (fn: (tx: unknown) => unknown) => fn({}) } as never,
      { async publish() {} } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        async findByUserId() {
          return null;
        },
      } as never,
      { isEnabled: async () => true } as never,
      {} as never,
    );
    const paymentService = new PaymentService(
      {} as never,
      intentService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new IdempotencyRepository(fakeRedis() as never),
    );
    const controller = new CommissionWalletController(
      paymentService,
      {
        async findById() {
          return { status: 'ACTIVE', amount: new Decimal(500) };
        },
      } as never,
      {
        async findByUserId(userId: string) {
          return drivers[userId] ?? null;
        },
      } as never,
    );
    const recharge = async (userId: string, key: string) => {
      let sent: { data: { intentId: string; gatewayIntentId: string } } | undefined;
      await controller.recharge(
        {
          auth: { userId, roles: ['driver'], sid: 's' },
          headers: { 'idempotency-key': key },
          body: { rechargeOptionId: OPTION_ID },
        } as never,
        {
          send(body: { data: { intentId: string; gatewayIntentId: string } }) {
            sent = body;
          },
        } as never,
      );
      return sent!.data;
    };
    return { intents, gatewayCalls, intentService, recharge };
  }

  it('gives two drivers who send the same key two separate intents and orders', async () => {
    const w = world();

    const a = await w.recharge('user_a', 'shared-key');
    const b = await w.recharge('user_b', 'shared-key');

    assert.notEqual(a.intentId, b.intentId);
    assert.notEqual(a.gatewayIntentId, b.gatewayIntentId);
    assert.ok(![a.intentId, a.gatewayIntentId].some((v) => JSON.stringify(b).includes(v)));
    assert.deepEqual([...w.intents.keys()].sort(), [
      'recharge:driver_a:shared-key',
      'recharge:driver_b:shared-key',
    ]);
  });

  it('replays one driver’s retry with the same key as the same intent, with one gateway call', async () => {
    const w = world();

    const first = await w.recharge('user_a', 'k1');
    const retry = await w.recharge('user_a', 'k1');

    assert.equal(retry.intentId, first.intentId);
    assert.equal(w.gatewayCalls.length, 1);
  });

  it('keeps one driver’s recharge and subscription with the same raw key apart', async () => {
    const w = world();
    const subscriptions = new SubscriptionService(
      {
        async findById() {
          return {
            id: 'plan_1',
            status: 'ACTIVE',
            price: new Decimal(99),
            billingPeriod: 'WEEKLY',
          };
        },
      } as never,
      {
        async findActive() {
          return null;
        },
        async findPending() {
          return null;
        },
        async create() {
          return { id: 'sub_1' };
        },
      } as never,
      w.intentService,
      {
        execute: (fn: (tx: unknown) => unknown) =>
          fn({ driverSubscription: { async update() {} } }),
      } as never,
      { async lockForUpdate() {} } as never,
    );

    const recharge = await w.recharge('user_a', 'same-raw-key');
    const sub = await subscriptions.purchase('driver_a', 'user_a', 'plan_1', 'same-raw-key');

    assert.notEqual(sub.intentId, recharge.intentId);
    assert.deepEqual([...w.intents.keys()].sort(), [
      'recharge:driver_a:same-raw-key',
      'subscription:driver_a:same-raw-key',
    ]);
  });

  it('never hands back an intent that belongs to another user, and says nothing about it', async () => {
    const w = world();
    w.intents.set('recharge:driver_a:k9', {
      id: 'intent_of_a',
      userId: 'user_a',
      purpose: 'DRIVER_COMMISSION_RECHARGE',
    });

    await assert.rejects(
      w.intentService.createIntent({
        userId: 'user_b',
        amount: new Decimal(500),
        methodType: 'CARD',
        idempotencyKey: 'recharge:driver_a:k9',
        purpose: 'DRIVER_COMMISSION_RECHARGE',
      }),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateIdempotencyKeyError);
        assert.ok(!err.message.includes('intent_of_a'));
        return true;
      },
    );
    assert.equal(w.gatewayCalls.length, 0);
  });

  it('claims payment keys with the short in-flight TTL and keeps results for the full TTL', async () => {
    const seen: { ttl: number; inFlight: number | undefined }[] = [];
    const redis = {
      idempotency: {
        async get() {
          return null;
        },
        async runOnce<T>(
          _op: string,
          _key: string,
          ttl: number,
          action: () => Promise<T>,
          inFlight?: number,
        ) {
          seen.push({ ttl, inFlight });
          return action();
        },
      },
    };
    const svc = new PaymentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new IdempotencyRepository(redis as never),
    );

    await svc.withIdempotency('user-1', '/payments/driver-wallet/recharge', 'k', {}, async () => 1);

    assert.deepEqual(seen, [
      {
        ttl: paymentConfig.idempotencyTtlSeconds,
        inFlight: paymentConfig.idempotencyInFlightTtlSeconds,
      },
    ]);
    assert.ok(paymentConfig.idempotencyInFlightTtlSeconds < paymentConfig.idempotencyTtlSeconds);
  });
});
