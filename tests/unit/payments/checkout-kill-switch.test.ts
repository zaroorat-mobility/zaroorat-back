import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decimal } from '../../../src/modules/payments/types/index.js';
import { IntentService } from '../../../src/modules/payments/services/intent/intent.service.js';
import { SubscriptionService } from '../../../src/modules/subscriptions/services/subscription.service.js';
import { FeatureFlagService } from '../../../src/modules/admin/system-settings/platform/services/feature-flag.service.js';
import { PAYMENT_FEATURE_FLAG_KEYS } from '../../../src/modules/admin/system-settings/platform/constants/payment-feature-flags.constants.js';
import { FEATURE_FLAG_SEED } from '../../../src/modules/admin/system-settings/platform/constants/platform-settings.constants.js';
import {
  PaymentGatewayUnavailableError,
  PaymentPurposeNotAllowedError,
  PaymentsUnavailableError,
} from '../../../src/modules/payments/errors/payment.errors.js';
import { handlePaymentError } from '../../../src/modules/payments/schemas/error-response.js';
import { handleSubscriptionError } from '../../../src/modules/subscriptions/schemas/error-response.js';
import type { GatewayPaymentPurpose } from '../../../src/modules/payments/constants/payment.constants.js';

/// 005-razorpay-driver-payments T035 (TM-14): one kill switch per payment
/// purpose, both seeded OFF; a refusal happens before any write, and an intent
/// that already exists is still confirmed.

type FlagRow = { key: string; status: string; name: string; description: string | null };

function flagDb(preset: Record<string, string> = {}) {
  const rows = new Map<string, FlagRow>(
    Object.entries(preset).map(([key, status]) => [
      key,
      { key, status, name: key, description: null },
    ]),
  );
  const client = {
    featureFlag: {
      async upsert(args: {
        where: { key: string };
        update: { name: string; description: string };
        create: FlagRow & { rolloutPercentage: number; isActive: boolean };
      }) {
        const row = rows.get(args.where.key);
        if (row) Object.assign(row, args.update);
        else rows.set(args.where.key, { ...args.create });
        return rows.get(args.where.key);
      },
      async findUnique(args: { where: { key: string } }) {
        const row = rows.get(args.where.key);
        return row ? { ...row, isActive: true, rolloutPercentage: 100 } : null;
      },
    },
  };
  return { db: { client } as never, rows };
}

/// IntentService with every collaborator faked and every write recorded.
function intentHarness(flags: FeatureFlagService) {
  const writes: string[] = [];
  const ledgerGroups: { direction: string; amount: Decimal }[][] = [];
  const stored = {
    id: 'intent_1',
    userId: 'user_1',
    rideId: null,
    amount: new Decimal(500),
    currency: 'INR',
    status: 'PENDING',
    gateway: 'mock',
    gatewayIntentId: 'order_1',
    purpose: 'DRIVER_COMMISSION_RECHARGE',
  };
  const intentRepo = {
    async findByIdempotencyKey() {
      writes.push('read:idempotency');
      return null;
    },
    async create(input: unknown) {
      writes.push('intent.create');
      return { id: 'intent_new', ...(input as object) };
    },
    async lockForUpdate() {
      return { ...stored };
    },
    async updateStatus(_id: string, status: string) {
      writes.push(`intent.status:${status}`);
      return { ...stored, status };
    },
    async recordTransaction() {
      writes.push('transaction');
    },
    async findPaymentRecords() {
      return [];
    },
    async findSucceededPayment() {
      return null;
    },
  };
  const gatewayResolver = {
    async getActiveGateway() {
      return {
        gatewayName: 'mock',
        async createIntent() {
          writes.push('gateway.createIntent');
          return { gatewayIntentId: 'order_new', status: 'PENDING' };
        },
      };
    },
  };
  const ledgerService = {
    async postTransactionGroup(legs: { direction: string; amount: Decimal }[]) {
      ledgerGroups.push(legs);
      writes.push('ledger');
    },
  };
  const txManager = {
    execute: (fn: (tx: unknown) => unknown) => {
      writes.push('tx');
      return fn({});
    },
  };
  const eventPublisher = {
    async publish() {
      writes.push('outbox');
    },
  };
  const metrics = { success() {}, failure() {} };
  const commissionWallet = {
    async creditInTx() {
      writes.push('wallet.credit');
    },
  };
  const drivers = {
    async findByUserId() {
      return { id: 'driver_1' };
    },
  };
  const service = new IntentService(
    intentRepo as never,
    gatewayResolver as never,
    ledgerService as never,
    txManager as never,
    eventPublisher as never,
    metrics as never,
    {} as never,
    commissionWallet as never,
    drivers as never,
    flags,
    {} as never,
  );
  const create = (purpose: GatewayPaymentPurpose | string) =>
    service.createIntent({
      userId: 'user_1',
      amount: new Decimal(500),
      methodType: 'CARD',
      idempotencyKey: 'recharge:driver_1:key_1',
      purpose: purpose as GatewayPaymentPurpose,
    });
  return { service, create, writes, ledgerGroups };
}

const balanced = (legs: { direction: string; amount: Decimal }[]) => {
  const sum = (direction: string) =>
    legs
      .filter((l) => l.direction === direction)
      .reduce((total, l) => total.add(l.amount), new Decimal(0));
  return sum('DEBIT').equals(sum('CREDIT'));
};

describe('payment kill switches — seeding (TD-12, TD-19)', () => {
  it('creates both payment switches OFF and pilot mode ON on a fresh database', async () => {
    const { db, rows } = flagDb();
    await new FeatureFlagService(db).ensureSeeded();

    assert.equal(rows.get(PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT)?.status, 'OFF');
    assert.equal(rows.get(PAYMENT_FEATURE_FLAG_KEYS.SUBSCRIPTION_CHECKOUT)?.status, 'OFF');
    assert.equal(rows.get(PAYMENT_FEATURE_FLAG_KEYS.PILOT_MODE)?.status, 'ON');
  });

  it('still creates every pre-existing seeded flag ON', async () => {
    const { db, rows } = flagDb();
    await new FeatureFlagService(db).ensureSeeded();

    for (const flag of FEATURE_FLAG_SEED) assert.equal(rows.get(flag.key)?.status, 'ON');
  });

  it('never changes a status staff have already set when it re-seeds', async () => {
    const { db, rows } = flagDb({
      [PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT]: 'ON',
      [PAYMENT_FEATURE_FLAG_KEYS.PILOT_MODE]: 'OFF',
    });
    const flags = new FeatureFlagService(db);
    await flags.ensureSeeded();
    await flags.ensureSeeded();

    assert.equal(rows.get(PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT)?.status, 'ON');
    assert.equal(rows.get(PAYMENT_FEATURE_FLAG_KEYS.PILOT_MODE)?.status, 'OFF');
  });

  it('reads both payment switches as disabled by default', async () => {
    const flags = new FeatureFlagService(flagDb().db);

    assert.equal(await flags.isEnabled(PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT), false);
    assert.equal(await flags.isEnabled(PAYMENT_FEATURE_FLAG_KEYS.SUBSCRIPTION_CHECKOUT), false);
  });
});

describe('payment kill switches — creating intents', () => {
  for (const purpose of ['DRIVER_COMMISSION_RECHARGE', 'DRIVER_SUBSCRIPTION_PAYMENT'] as const) {
    // "Write" means a payment-side effect: intent, transaction, ledger, wallet,
    // outbox or gateway. The flag service's own self-seeding of `feature_flags`
    // (existing behaviour, plan.md K-7) is outside that and still runs.
    it(`refuses a new ${purpose} intent with 503 before any payment read, gateway call or write`, async () => {
      const h = intentHarness(new FeatureFlagService(flagDb().db));

      await assert.rejects(h.create(purpose), (err: unknown) => {
        assert.ok(err instanceof PaymentsUnavailableError);
        assert.equal(err.code, 'PAYMENTS_UNAVAILABLE');
        assert.equal(err.statusCode, 503);
        return true;
      });
      assert.deepEqual(h.writes, []);
    });
  }

  it('keeps the two switches independent', async () => {
    const h = intentHarness(
      new FeatureFlagService(flagDb({ [PAYMENT_FEATURE_FLAG_KEYS.DRIVER_CHECKOUT]: 'ON' }).db),
    );

    await h.create('DRIVER_COMMISSION_RECHARGE');
    assert.ok(h.writes.includes('intent.create'));
    await assert.rejects(h.create('DRIVER_SUBSCRIPTION_PAYMENT'), PaymentsUnavailableError);
  });

  it('still refuses a non-driver purpose first, whatever the switches say (E-11)', async () => {
    const h = intentHarness(new FeatureFlagService(flagDb().db));

    await assert.rejects(h.create('CUSTOMER_WALLET_TOPUP'), PaymentPurposeNotAllowedError);
    assert.deepEqual(h.writes, []);
  });
});

describe('payment kill switches — existing intents still confirm', () => {
  it('applies a captured recharge with both switches OFF, with a balanced ledger group', async () => {
    let flagReads = 0;
    const flags = {
      async isEnabled() {
        flagReads += 1;
        return false;
      },
    } as unknown as FeatureFlagService;
    const h = intentHarness(flags);

    const updated = await h.service.applyConfirmation(
      'intent_1',
      {
        kind: 'payment',
        payment: {
          id: 'pay_1',
          orderId: 'order_1',
          amountPaise: 50000,
          currency: 'INR',
          status: 'captured',
        },
      },
      'WEBHOOK',
      {} as never,
    );

    assert.equal(updated.status, 'SUCCEEDED');
    assert.equal(flagReads, 0);
    assert.ok(h.writes.includes('wallet.credit'));
    assert.equal(h.ledgerGroups.length, 1);
    for (const group of h.ledgerGroups) assert.ok(balanced(group), 'debits must equal credits');
  });
});

describe('payment kill switches — subscription purchase writes nothing while OFF', () => {
  function subscriptionHarness(active: { planId: string } | null) {
    const writes: string[] = [];
    const flags = new FeatureFlagService(flagDb().db);
    const intents = intentHarness(flags);
    const service = new SubscriptionService(
      {
        async findById() {
          return {
            id: 'plan_new',
            status: 'ACTIVE',
            price: new Decimal(99),
            billingPeriod: 'WEEKLY',
          };
        },
      } as never,
      {
        async findActive() {
          return active;
        },
        async stagePendingPlan() {
          writes.push('subscription.stage');
        },
        async findPending() {
          return null;
        },
        async create() {
          writes.push('subscription.create');
          return { id: 'sub_1' };
        },
      } as never,
      intents.service,
      { execute: (fn: (tx: unknown) => unknown) => fn({}) } as never,
      {
        async lockForUpdate() {},
      } as never,
    );
    return { service, writes, intentWrites: intents.writes };
  }

  it('refuses a first purchase with 503 and creates no subscription row and no intent', async () => {
    const h = subscriptionHarness(null);

    await assert.rejects(
      h.service.purchase('driver_1', 'user_1', 'plan_new', 'key_1'),
      PaymentsUnavailableError,
    );
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.intentWrites, []);
  });

  it('still stages a plan change for an active subscriber, which needs no payment', async () => {
    const h = subscriptionHarness({ planId: 'plan_old' });

    const result = await h.service.purchase('driver_1', 'user_1', 'plan_new', 'key_1');
    assert.equal(result.intentId, null);
    assert.deepEqual(h.writes, ['subscription.stage']);
  });
});

describe('payment kill switches — HTTP mapping', () => {
  function reply() {
    const out: { status?: number; body?: unknown } = {};
    const r = {
      status(code: number) {
        out.status = code;
        return r;
      },
      send(body: unknown) {
        out.body = body;
        return r;
      },
    };
    return { r, out };
  }
  const request = { id: 'req_1', log: { error() {} } };

  for (const [name, handler] of [
    ['payments', handlePaymentError],
    ['subscriptions', handleSubscriptionError],
  ] as const) {
    it(`answers 503 PAYMENTS_UNAVAILABLE on the ${name} routes, not a generic 500`, () => {
      const { r, out } = reply();
      handler(new PaymentsUnavailableError(), request as never, r as never);

      assert.equal(out.status, 503);
      assert.equal((out.body as { error: { code: string } }).error.code, 'PAYMENTS_UNAVAILABLE');
    });

    // 005 T043: provider unreachable during verify or order creation.
    it(`answers 503 PAYMENT_GATEWAY_UNAVAILABLE with its fixed message on the ${name} routes`, () => {
      const { r, out } = reply();
      handler(new PaymentGatewayUnavailableError(), request as never, r as never);

      const { error } = out.body as { error: { code: string; message: string } };
      assert.equal(out.status, 503);
      assert.equal(error.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
      assert.equal(error.message, 'Payment provider unavailable; retry later');
    });
  }
});
