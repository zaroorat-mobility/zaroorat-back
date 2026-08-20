import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it, beforeEach } from 'node:test';

import { WebhookService } from '../../../src/modules/payments/services/webhook/webhook.service.js';
import {
  WebhookEventIdMissingError,
  WebhookReplayError,
  WebhookSignatureError,
} from '../../../src/modules/payments/errors/payment.errors.js';
import { paymentConfig } from '../../../src/config/payment/payment.config.js';

const SECRET = paymentConfig.webhookSecret;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
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
    txManager as never,
    metrics as never,
  );

  return { service, calls };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_1',
    type: 'payment.succeeded',
    created: nowSeconds(),
    data: { object: { id: 'pi_1' } },
    ...overrides,
  };
}

describe('Payment webhook security', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('rejects an invalid signature before touching the database', async () => {
    const body = JSON.stringify(payload());
    await assert.rejects(
      () => h.service.handleGatewayWebhook('stripe', body, 'not-a-signature', payload()),
      (err: unknown) => err instanceof WebhookSignatureError,
    );
    assert.equal(h.calls.markedProcessed.length, 0);
    assert.equal(h.calls.confirmed.length, 0);
  });

  it('processes a valid recent event and settles the intent', async () => {
    const p = payload();
    const body = JSON.stringify(p);
    const result = await h.service.handleGatewayWebhook('stripe', body, sign(body), p);

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
      () => h.service.handleGatewayWebhook('stripe', body, sign(body), p),
      (err: unknown) => err instanceof WebhookEventIdMissingError,
    );
    assert.equal(h.calls.confirmed.length, 0);
  });

  it('rejects a replayed event outside the tolerance window', async () => {
    const p = payload({ created: nowSeconds() - (paymentConfig.webhookToleranceSeconds + 60) });
    const body = JSON.stringify(p);

    await assert.rejects(
      () => h.service.handleGatewayWebhook('stripe', body, sign(body), p),
      (err: unknown) => err instanceof WebhookReplayError,
    );
    assert.equal(h.calls.confirmed.length, 0);
  });

  it('treats a duplicate delivery as processed without a second financial effect', async () => {
    const dup = harness({ duplicate: true });
    const p = payload();
    const body = JSON.stringify(p);

    const result = await dup.service.handleGatewayWebhook('stripe', body, sign(body), p);

    assert.equal(result.isDuplicate, true);
    assert.deepEqual(dup.calls.confirmed, [], 'a duplicate must not settle the intent again');
    assert.equal(dup.calls.markedProcessed.length, 0);
  });

  it('rolls back and does NOT mark processed when confirmation fails', async () => {
    const failing = harness({ confirmThrows: new Error('ledger unavailable') });
    const p = payload();
    const body = JSON.stringify(p);

    await assert.rejects(
      () => failing.service.handleGatewayWebhook('stripe', body, sign(body), p),
      /ledger unavailable/,
    );

    assert.equal(failing.calls.markedProcessed.length, 0, 'must not mark processed');
    assert.equal(failing.calls.rolledBack, 1, 'transaction must roll back');
    assert.equal(failing.calls.committed, 0);
  });

  it('lets the gateway retry succeed after a transient failure', async () => {
    const p = payload();
    const body = JSON.stringify(p);

    const failing = harness({ confirmThrows: new Error('transient') });
    await assert.rejects(() => failing.service.handleGatewayWebhook('stripe', body, sign(body), p));

    const retry = harness();
    const result = await retry.service.handleGatewayWebhook('stripe', body, sign(body), p);
    assert.equal(result.processed, true);
    assert.deepEqual(retry.calls.confirmed, ['pi_1']);
  });

  it('rejects a payload whose body was modified after signing', async () => {
    const signed = JSON.stringify(payload());
    const tampered = payload({ data: { object: { id: 'pi_attacker' } } });

    await assert.rejects(
      () =>
        h.service.handleGatewayWebhook('stripe', JSON.stringify(tampered), sign(signed), tampered),
      (err: unknown) => err instanceof WebhookSignatureError,
    );
  });
});
