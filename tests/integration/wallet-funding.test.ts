import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';
import { Decimal } from '../../src/modules/payments/types/index.js';
import type { WalletService } from '../../src/modules/payments/services/wallet/wallet.service.js';
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

  function topup(user: LoggedInUser, amount: number) {
    return app.inject({
      method: 'POST',
      url: TOPUP,
      headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
      payload: { amount },
    });
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

  function deliverWebhook(intentId: string, eventId = `evt_${randomUUID()}`) {
    const body = JSON.stringify({
      id: eventId,
      type: 'payment.succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: intentId } },
    });
    return app.inject({
      method: 'POST',
      url: WEBHOOK,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', paymentConfig.webhookSecret)
          .update(body)
          .digest('hex'),
      },
      payload: body,
    });
  }

  // ── RT-1: a request is not a payment ──────────────────────────────────────

  it('does not credit a balance for a top-up with no payment behind it', async () => {
    const rider = await loginAs(app, RIDER);

    const response = await topup(rider, 500);

    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().data.balance, 0, 'asking to pay is not paying');
    assert.equal(await balanceOf(rider), 0, 'and it is still zero on re-read');
    assert.equal(await ledgerPosition(rider.userId), 0, 'the books agree');
  });

  it('returns a payment intent to take to the gateway', async () => {
    const rider = await loginAs(app, RIDER);

    const body = (await topup(rider, 500)).json().data;

    assert.ok(body.intentId, 'the client is told what to pay');
    assert.equal(body.amount, 500);
    // Additive: every field the old response carried is still here.
    for (const field of [
      'id',
      'userId',
      'balance',
      'lockedBalance',
      'availableBalance',
      'currency',
    ])
      assert.ok(field in body, `${field} survives`);

    const intent = await db().client.paymentIntent.findUniqueOrThrow({
      where: { id: body.intentId },
    });
    assert.equal(intent.userId, rider.userId);
    assert.equal(intent.status, 'PENDING');
  });

  it('refuses a top-up with no idempotency key', async () => {
    const rider = await loginAs(app, RIDER);

    const response = await app.inject({
      method: 'POST',
      url: TOPUP,
      headers: rider.authHeader,
      payload: { amount: 500 },
    });

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(await balanceOf(rider), 0);
  });

  // ── RT-2: a confirmed payment credits exactly once ────────────────────────

  it('credits exactly once when the gateway confirms, and not again on redelivery', async () => {
    const rider = await loginAs(app, RIDER);
    const { intentId } = (await topup(rider, 750)).json().data;

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
    const { intentId } = (await topup(rider, 300)).json().data;

    await deliverWebhook(intentId);
    // A different event id, so the gateway-event guard does not catch it — the
    // intent's own terminal state has to.
    await deliverWebhook(intentId);

    assert.equal(await balanceOf(rider), 300);
  });

  it('leaves the balance alone when the gateway reports a failure', async () => {
    const rider = await loginAs(app, RIDER);
    const { intentId } = (await topup(rider, 400)).json().data;

    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: intentId } },
    });
    await app.inject({
      method: 'POST',
      url: WEBHOOK,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': createHmac('sha256', paymentConfig.webhookSecret)
          .update(body)
          .digest('hex'),
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
      const { intentId } = (await topup(rider, amount)).json().data;
      await deliverWebhook(intentId);
    }

    assert.equal(await balanceOf(rider), 1199.75);
    assert.equal(await ledgerPosition(rider.userId), 1199.75, 'to the paise');
  });

  // ── Concurrent spend ──────────────────────────────────────────────────────

  it('lets exactly one of two concurrent overlapping debits through', async () => {
    const rider = await loginAs(app, RIDER);
    const { intentId } = (await topup(rider, 1000)).json().data;
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
    const { intentId } = (await topup(rider, 500)).json().data;
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
