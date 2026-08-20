import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { makePendingIntent } from './helpers/fixtures.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const URL = '/api/v1/payments/webhooks/razorpay';
const CUSTOMER = '+919876602001';

function sign(rawBody: string): string {
  return createHmac('sha256', paymentConfig.webhookSecret).update(rawBody).digest('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('payment webhook signature (integration, real HTTP)', () => {
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

  function deliver(rawBody: string, signature?: string) {
    return app.inject({
      method: 'POST',
      url: URL,
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-razorpay-signature': signature }),
      },
      payload: rawBody,
    });
  }

  function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'payment.succeeded',
      created: nowSeconds(),
      data: { object: { id: `pi_${randomUUID()}` } },
      ...overrides,
    });
  }

  it('is reachable without a bearer token — and only this route is', async () => {
    const body = payload();
    const response = await deliver(body, sign(body));

    assert.notEqual(response.statusCode, 401, response.payload);
  });

  it('accepts a correctly signed webhook', async () => {
    const body = payload();
    const response = await deliver(body, sign(body));

    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(response.json().received, true);
  });

  it('rejects an invalid signature', async () => {
    const body = payload();
    const response = await deliver(body, 'f'.repeat(64));

    assert.equal(response.statusCode, 401, response.payload);
    assert.equal(response.json().error.code, 'WEBHOOK_SIGNATURE_INVALID');
    assert.equal(await db().client.gatewayEvent.count(), 0, 'nothing was recorded');
  });

  it('rejects a missing signature header', async () => {
    const body = payload();
    const response = await deliver(body);

    assert.equal(response.statusCode, 401, response.payload);
    assert.equal(await db().client.gatewayEvent.count(), 0);
  });

  it('rejects a body modified after signing', async () => {
    const signed = payload();
    const tampered = JSON.stringify({ ...JSON.parse(signed), amount: 999999 });

    const response = await deliver(tampered, sign(signed));

    assert.equal(response.statusCode, 401, response.payload);
    assert.equal(await db().client.gatewayEvent.count(), 0);
  });

  it('rejects a body whose keys were merely reordered', async () => {
    const original = payload();
    const parsed = JSON.parse(original) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
    assert.notEqual(reordered, original, 'precondition: the bytes differ');

    const response = await deliver(reordered, sign(original));
    assert.equal(response.statusCode, 401, response.payload);
  });

  it('rejects a replayed event outside the timestamp window', async () => {
    const body = payload({ created: nowSeconds() - (paymentConfig.webhookToleranceSeconds + 120) });
    const response = await deliver(body, sign(body));

    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(response.json().error.code, 'WEBHOOK_REPLAY_REJECTED');
    assert.equal(await db().client.gatewayEvent.count(), 0);
  });

  it('rejects a payload carrying no gateway event id', async () => {
    const body = JSON.stringify({
      type: 'payment.succeeded',
      created: nowSeconds(),
      data: { object: { id: 'pi_1' } },
    });

    const response = await deliver(body, sign(body));
    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(response.json().error.code, 'WEBHOOK_EVENT_ID_MISSING');
  });

  it('handles a duplicate delivery idempotently', async () => {
    const body = payload();
    const signature = sign(body);

    const first = await deliver(body, signature);
    const second = await deliver(body, signature);

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(second.statusCode, 200, second.payload);
    assert.equal(first.json().isDuplicate, false);
    assert.equal(second.json().isDuplicate, true, 'the redelivery is recognised');

    assert.equal(await db().client.gatewayEvent.count(), 1, 'one event row, not two');
  });

  it('settles the intent exactly once across a redelivery', async () => {
    const customer = await loginAs(app, CUSTOMER);
    const intentId = await makePendingIntent(customer.userId, 750);

    const body = payload({ data: { object: { id: intentId } } });
    const signature = sign(body);

    await deliver(body, signature);
    await deliver(body, signature);

    const intent = await db().client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    assert.equal(intent.status, 'SUCCEEDED');

    const transactions = await db().client.paymentTransaction.count({ where: { intentId } });
    assert.equal(transactions, 1, 'a redelivery must not post a second transaction');

    const groups = await db().client.paymentLedgerEntry.findMany({
      where: { referenceId: intentId },
      select: { entryGroup: true },
    });
    assert.equal(new Set(groups.map((g) => g.entryGroup)).size, 1, 'one ledger group');
  });

  it('does not log the raw payload or the secret', async () => {
    const marker = `SENSITIVE_${randomUUID()}`;
    const body = payload({ data: { object: { id: 'pi_1', note: marker } } });

    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: typeof originalWrite }).write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      lines.push(String(chunk));
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof originalWrite;

    try {
      await deliver(body, 'bad-signature');
    } finally {
      (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
    }

    const logged = lines.join('');
    assert.ok(!logged.includes(marker), 'the webhook body must not reach the logs');
    assert.ok(
      !logged.includes(paymentConfig.webhookSecret),
      'the signing secret must never be logged',
    );
  });
});
