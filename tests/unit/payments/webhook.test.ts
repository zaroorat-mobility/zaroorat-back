import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyWebhookSignature } from '../../../src/modules/payments/utils/signature.util.js';
import { WebhookService } from '../../../src/modules/payments/services/webhook/webhook.service.js';
import { WebhookSignatureError } from '../../../src/modules/payments/errors/payment.errors.js';
import { createHmac } from 'node:crypto';

describe('Webhook Signature & Deduplication Tests', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ event: 'payment.succeeded', id: 'evt_1001' });
  const validSig = createHmac('sha256', secret).update(body).digest('hex');

  it('validates HMAC SHA256 signature correctly', () => {
    assert.equal(verifyWebhookSignature(body, validSig, secret), true);
    assert.equal(verifyWebhookSignature(body, 'invalid_sig', secret), false);
  });

  it('rejects webhooks carrying invalid signature', async () => {
    const service = new WebhookService(
      {} as never,
      {} as never,
      {} as never,
      { webhookReceived: () => {}, webhookFailure: () => {} } as never,
    );

    await assert.rejects(
      async () =>
        service.handleGatewayWebhook('razorpay', body, 'bad_signature', {
          event: 'payment.succeeded',
        }),
      WebhookSignatureError,
    );
  });
});
