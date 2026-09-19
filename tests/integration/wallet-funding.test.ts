import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { WalletService } from '../../src/modules/payments/services/wallet/wallet.service.js';
import type { IntentService } from '../../src/modules/payments/services/intent/intent.service.js';
import type { GatewayPaymentPurpose } from '../../src/modules/payments/constants/payment.constants.js';
import { PaymentPurposeNotAllowedError } from '../../src/modules/payments/errors/payment.errors.js';
import { captureGatewayIntentInputs } from './helpers/ride-flow.js';
import type { TransactionManager } from '../../src/core/database/TransactionManager.js';

const RIDER = '+919876603001';
const TOPUP = '/api/v1/payments/wallet/topup';
const BALANCE = '/api/v1/payments/wallet/balance';
const WEBHOOK = '/api/v1/payments/webhooks/razorpay';

describe('wallet funding integrity (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await db().client.$executeRawUnsafe('TRUNCATE "gateway_events" CASCADE');
    await resetState();
  });

  /// A historical CUSTOMER_WALLET_TOPUP intent, still awaiting capture. New
  /// top-ups can no longer be created (`GATEWAY_PAYMENT_PURPOSES`); this is the
  /// only kind left, and it must still credit exactly once when captured.
  async function legacyTopup(user: LoggedInUser, amount: number): Promise<string> {
    const intent = await db().client.paymentIntent.create({
      data: {
        userId: user.userId,
        amount,
        currency: 'INR',
        methodType: 'CARD',
        idempotencyKey: `legacy_topup_${randomUUID()}`,
        status: 'PENDING',
        gateway: 'mock',
        gatewayIntentId: `mock_pi_${randomUUID()}`,
        purpose: 'CUSTOMER_WALLET_TOPUP',
      },
    });
    return intent.id;
  }

  async function balanceOf(user: LoggedInUser): Promise<number> {
    const response = await app.inject({ method: 'GET', url: BALANCE, headers: user.authHeader });
    assert.equal(response.statusCode, 200, response.payload);
    return response.json().data.balance;
  }

  /// The `CUSTOMER_WALLET` position as the books see it: credits less debits.
  async function ledgerPosition(userId: string): Promise<number> {
    const rows = await db().client.paymentLedgerEntry.findMany({
      where: { account: 'CUSTOMER_WALLET', accountRefId: userId },
      select: { direction: true, amount: true },
    });
    return rows.reduce(
      (total, row) =>
        row.direction === 'CREDIT' ? total + row.amount.toNumber() : total - row.amount.toNumber(),
      0,
    );
  }

  /// Real Razorpay webhook envelope — `event` at the top, the payment nested
  /// under `payload.payment.entity`, `order_id` as the order reference.
  /// `orderReference` may be either the intent's real `gatewayIntentId` or
  /// (as most callers here pass) its own internal `PaymentIntent.id` —
  /// `IntentService.findByGatewayReference` accepts either, falling back to
  /// a UUID-pattern match against the intent's own id when it is not a
  /// recognised gateway reference.
  function deliverWebhook(orderReference: string, eventId = `evt_${randomUUID()}`) {
    const body = JSON.stringify({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
            order_id: orderReference,
            status: 'captured',
          },
        },
      },
    });
    return app.inject({
      method: 'POST',
      url: WEBHOOK,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac(
          'sha256',
          paymentConfig.razorpayWebhookSecret ?? paymentConfig.webhookSecret,
        )
          .update(body)
          .digest('hex'),
        'x-razorpay-event-id': eventId,
      },
      payload: body,
    });
  }

  // ── RT-1: customers cannot start a gateway payment ─────────────────────

  it('has no customer top-up route — a ride fare is paid to the driver, never a gateway', async () => {
    const rider = await loginAs(app, RIDER);

    for (const url of [TOPUP, '/api/v1/payments/intents', '/api/v1/payments/wallet/hold']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { ...rider.authHeader, 'idempotency-key': randomUUID() },
        payload: { amount: 500, methodType: 'CARD' },
      });
      assert.equal(response.statusCode, 404, `${url}: ${response.payload}`);
    }
    assert.equal(
      await db().client.paymentIntent.count({ where: { userId: rider.userId } }),
      0,
      'no intent was created',
    );
    assert.equal(await db().client.walletHold.count(), 0, 'no hold was created');
    assert.equal(await balanceOf(rider), 0);
  });

  it('refuses any purpose outside the gateway invariant before calling a gateway', async () => {
    const rider = await loginAs(app, RIDER);
    const intents = container.resolve<IntentService>('intentService');
    const capture = captureGatewayIntentInputs();
    try {
      for (const purpose of ['CUSTOMER_WALLET_TOPUP', 'CUSTOMER_RIDE_PAYMENT']) {
        await assert.rejects(
          intents.createIntent({
            userId: rider.userId,
            amount: new Decimal(500),
            methodType: 'CARD',
            idempotencyKey: randomUUID(),
            purpose: purpose as GatewayPaymentPurpose,
          }),
          PaymentPurposeNotAllowedError,
        );
      }
      assert.equal(capture.calls.length, 0, 'no gateway was ever asked');
    } finally {
      capture.restore();
    }
    assert.equal(await db().client.paymentIntent.count({ where: { userId: rider.userId } }), 0);
  });

  it('reads the balance without ever creating a customer wallet', async () => {
    const rider = await loginAs(app, RIDER);

    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: 'GET', url: BALANCE, headers: rider.authHeader });
      assert.equal(response.statusCode, 200, response.payload);
      assert.deepEqual(response.json().data, {
        id: null,
        userId: rider.userId,
        balance: 0,
        lockedBalance: 0,
        availableBalance: 0,
        currency: 'INR',
      });
    }
    assert.equal(
      await db().client.customerWallet.count({ where: { userId: rider.userId } }),
      0,
      'a read inserts no customer_wallets row',
    );
  });

  it('does not credit a historical top-up that was never captured', async () => {
    const rider = await loginAs(app, RIDER);

    await legacyTopup(rider, 500);

    assert.equal(await balanceOf(rider), 0, 'asking to pay is not paying');
    assert.equal(await ledgerPosition(rider.userId), 0, 'the books agree');
  });

  // ── RT-2: a confirmed payment credits exactly once ────────────────────────

  it('credits exactly once when the gateway confirms, and not again on redelivery', async () => {
    const rider = await loginAs(app, RIDER);
    const intentId = await legacyTopup(rider, 750);

    const eventId = `evt_${randomUUID()}`;
    const first = await deliverWebhook(intentId, eventId);
    const second = await deliverWebhook(intentId, eventId);

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(second.json().isDuplicate, true, 'the redelivery is recognised');

    assert.equal(await balanceOf(rider), 750, 'credited once');
    const credits = await db().client.customerWalletTransaction.count({
      where: { userId: rider.userId },
    });
    assert.equal(credits, 1, 'one wallet transaction, not two');
  });

  it('credits once even when the gateway sends a second, distinct event', async () => {
    const rider = await loginAs(app, RIDER);
    const intentId = await legacyTopup(rider, 300);

    await deliverWebhook(intentId);
    // A different event id, so the gateway-event guard does not catch it — the
    // intent's own terminal state has to.
    await deliverWebhook(intentId);

    assert.equal(await balanceOf(rider), 300);
  });

  it('leaves the balance alone when the gateway reports a failure', async () => {
    const rider = await loginAs(app, RIDER);
    const intentId = await legacyTopup(rider, 400);

    const body = JSON.stringify({
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
            order_id: intentId,
            status: 'failed',
          },
        },
      },
    });
    await app.inject({
      method: 'POST',
      url: WEBHOOK,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac(
          'sha256',
          paymentConfig.razorpayWebhookSecret ?? paymentConfig.webhookSecret,
        )
          .update(body)
          .digest('hex'),
        'x-razorpay-event-id': `evt_${randomUUID()}`,
      },
      payload: body,
    });

    assert.equal(await balanceOf(rider), 0);
    assert.equal(await ledgerPosition(rider.userId), 0);
  });

  // ── RT-4: the balance is the ledger ───────────────────────────────────────

  it('keeps the balance equal to the ledger position through every funding', async () => {
    const rider = await loginAs(app, RIDER);

    for (const amount of [120.5, 79.25, 1000]) {
      const intentId = await legacyTopup(rider, amount);
      await deliverWebhook(intentId);
    }

    assert.equal(await balanceOf(rider), 1199.75);
    assert.equal(await ledgerPosition(rider.userId), 1199.75, 'to the paise');
  });

  // ── Concurrent spend ──────────────────────────────────────────────────────

  it('lets exactly one of two concurrent overlapping debits through', async () => {
    const rider = await loginAs(app, RIDER);
    const intentId = await legacyTopup(rider, 1000);
    await deliverWebhook(intentId);

    const wallet = container.resolve<WalletService>('walletService');
    const txManager = container.resolve<TransactionManager>('transactionManager');
    const spend = (reference: string) =>
      txManager.execute((tx) =>
        wallet.debitInTx(rider.userId, new Decimal(700), tx, {
          referenceType: 'RIDE',
          referenceId: reference,
        }),
      );

    const results = await Promise.allSettled([spend(randomUUID()), spend(randomUUID())]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'only one 700 fits in 1000');

    assert.equal(await balanceOf(rider), 300);
    const row = await db().client.customerWallet.findUniqueOrThrow({
      where: { userId: rider.userId },
    });
    assert.ok(row.balance.gte(0), 'the balance never goes negative');
  });

  it('records a spend as a negative wallet transaction', async () => {
    const rider = await loginAs(app, RIDER);
    const intentId = await legacyTopup(rider, 500);
    await deliverWebhook(intentId);

    const wallet = container.resolve<WalletService>('walletService');
    const txManager = container.resolve<TransactionManager>('transactionManager');
    await txManager.execute((tx) =>
      wallet.debitInTx(rider.userId, new Decimal(120), tx, {
        referenceType: 'RIDE',
        referenceId: randomUUID(),
      }),
    );

    const rows = await db().client.customerWalletTransaction.findMany({
      where: { userId: rider.userId },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(
      rows.map((row) => row.amount.toNumber()),
      [500, -120],
    );
    assert.equal(await balanceOf(rider), 380);
  });
});
