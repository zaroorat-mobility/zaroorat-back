import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it, beforeEach } from 'node:test';

import { WebhookService } from '../../../src/modules/payments/services/webhook/webhook.service.js';
import {
  WebhookEventIdMissingError,
  WebhookSignatureError,
} from '../../../src/modules/payments/errors/payment.errors.js';
import { paymentConfig } from '../../../src/config/payment/payment.config.js';

const SECRET = paymentConfig.stripeWebhookSecret ?? paymentConfig.webhookSecret;

/// Real Stripe signature construction — t=<seconds>,v1=<hmac of "t.body">
/// — never the bare hex-over-raw-body scheme this suite used before
/// per-provider verification existed.
function sign(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function harness(options: { confirmThrows?: Error; duplicate?: boolean } = {}) {
  const calls = {
    confirmed: [] as string[],
    markedProcessed: [] as string[],
    committed: 0,
    rolledBack: 0,
  };

  const webhookRepo = {
    async findOrPersist(data: { gatewayEventId: string }) {
      return {
        event: { id: `row_${data.gatewayEventId}` },
        isDuplicate: options.duplicate === true,
      };
    },
    async markProcessed(id: string) {
      calls.markedProcessed.push(id);
      return { id };
    },
  };

  const intentService = {
    async findByGatewayReference(reference: string) {
      return { id: reference };
    },
    async applyConfirmation(intentId: string) {
      if (options.confirmThrows) throw options.confirmThrows;
      calls.confirmed.push(intentId);
      return { id: intentId };
    },
  };

  const gatewayResolver = {
    async webhookSecretFor() {
      return SECRET;
    },
  };

  const txManager = {
    async execute<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const before = { ...calls, markedProcessed: [...calls.markedProcessed] };
      try {
        const result = await fn({});
        calls.committed += 1;
        return result;
      } catch (err) {
        calls.markedProcessed = before.markedProcessed;
        calls.rolledBack += 1;
        throw err;
      }
    },
  };

  const metrics = {
    webhookReceived() {},
    webhookFailure() {},
    webhookDuplicate() {},
  };

  const service = new WebhookService(
    webhookRepo as never,
    intentService as never,
    gatewayResolver as never,
    txManager as never,
    metrics as never,
  );

  return { service, calls };
}

/// A real Stripe `payment_intent.succeeded` event envelope — `data.object`
/// IS the PaymentIntent, so its own `id` (`pi_1`) is the intent reference.
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    created: nowSeconds(),
    data: { object: { id: 'pi_1' } },
    ...overrides,
  };
}

describe('Payment webhook security (Stripe verification path)', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('rejects an invalid signature before touching the database', async () => {
    const body = JSON.stringify(payload());
    await assert.rejects(
      () =>
        h.service.handleGatewayWebhook({
          gateway: 'stripe',
          rawBody: body,
          signature: 'not-a-signature',
          payload: payload(),
        }),
      (err: unknown) => err instanceof WebhookSignatureError,
    );
    assert.equal(h.calls.markedProcessed.length, 0);
    assert.equal(h.calls.confirmed.length, 0);
  });

  it('processes a valid recent event and settles the intent', async () => {
    const p = payload();
    const body = JSON.stringify(p);
    const result = await h.service.handleGatewayWebhook({
      gateway: 'stripe',
      rawBody: body,
      signature: sign(body),
      payload: p,
    });

    assert.equal(result.processed, true);
    assert.equal(result.isDuplicate, false);
    assert.deepEqual(h.calls.confirmed, ['pi_1']);
    assert.equal(h.calls.markedProcessed.length, 1);
    assert.equal(h.calls.committed, 1);
  });

  it('rejects a payload with no gateway event id rather than inventing one', async () => {
    const p = payload({ id: undefined });
    const body = JSON.stringify(p);

    await assert.rejects(
      () =>
        h.service.handleGatewayWebhook({
          gateway: 'stripe',
          rawBody: body,
          signature: sign(body),
          payload: p,
        }),
      (err: unknown) => err instanceof WebhookEventIdMissingError,
    );
    assert.equal(h.calls.confirmed.length, 0);
  });

  it('rejects a stale Stripe timestamp as a signature failure, not a separate replay check', async () => {
    // Real Stripe ties the timestamp into the signed payload itself
    // (`${t}.${body}`) and its own verification tolerance-checks `t` before
    // ever getting to parse the event — a stale delivery fails AT signature
    // verification, the same way Stripe's own `constructEvent` throws a
    // signature error for a stale timestamp rather than a distinct "replay"
    // error. `WebhookService.assertFresh`'s separate WebhookReplayError path
    // exists for providers whose OWN verifier does not already enforce
    // tolerance (Razorpay) — Stripe never reaches it.
    const staleTimestamp = nowSeconds() - (paymentConfig.webhookToleranceSeconds + 60);
    const p = payload({ created: staleTimestamp });
    const body = JSON.stringify(p);

    await assert.rejects(
      () =>
        h.service.handleGatewayWebhook({
          gateway: 'stripe',
          rawBody: body,
          signature: sign(body, staleTimestamp),
          payload: p,
        }),
      (err: unknown) => err instanceof WebhookSignatureError,
    );
    assert.equal(h.calls.confirmed.length, 0);
  });

  it('treats a duplicate delivery as processed without a second financial effect', async () => {
    const dup = harness({ duplicate: true });
    const p = payload();
    const body = JSON.stringify(p);

    const result = await dup.service.handleGatewayWebhook({
      gateway: 'stripe',
      rawBody: body,
      signature: sign(body),
      payload: p,
    });

    assert.equal(result.isDuplicate, true);
    assert.deepEqual(dup.calls.confirmed, [], 'a duplicate must not settle the intent again');
    assert.equal(dup.calls.markedProcessed.length, 0);
  });

  it('rolls back and does NOT mark processed when confirmation fails', async () => {
    const failing = harness({ confirmThrows: new Error('ledger unavailable') });
    const p = payload();
    const body = JSON.stringify(p);

    await assert.rejects(
      () =>
        failing.service.handleGatewayWebhook({
          gateway: 'stripe',
          rawBody: body,
          signature: sign(body),
          payload: p,
        }),
      /ledger unavailable/,
    );

    assert.equal(failing.calls.markedProcessed.length, 0, 'must not mark processed');
    assert.equal(failing.calls.rolledBack, 1, 'transaction must roll back');
    assert.equal(failing.calls.committed, 0);
  });

  it('lets the gateway retry succeed after a transient failure', async () => {
    const p = payload();
    const body = JSON.stringify(p);
    const signature = sign(body);

    const failing = harness({ confirmThrows: new Error('transient') });
    await assert.rejects(() =>
      failing.service.handleGatewayWebhook({
        gateway: 'stripe',
        rawBody: body,
        signature,
        payload: p,
      }),
    );

    const retry = harness();
    const result = await retry.service.handleGatewayWebhook({
      gateway: 'stripe',
      rawBody: body,
      signature,
      payload: p,
    });
    assert.equal(result.processed, true);
    assert.deepEqual(retry.calls.confirmed, ['pi_1']);
  });

  it('rejects a payload whose body was modified after signing', async () => {
    const signed = JSON.stringify(payload());
    const tampered = payload({ data: { object: { id: 'pi_attacker' } } });

    await assert.rejects(
      () =>
        h.service.handleGatewayWebhook({
          gateway: 'stripe',
          rawBody: JSON.stringify(tampered),
          signature: sign(signed),
          payload: tampered,
        }),
      (err: unknown) => err instanceof WebhookSignatureError,
    );
  });
});
