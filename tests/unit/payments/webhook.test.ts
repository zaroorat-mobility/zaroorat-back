import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyRazorpayWebhookSignature } from '../../../src/integrations/razorpay/razorpay.client.js';
import { verifyStripeWebhookSignature } from '../../../src/integrations/stripe/stripe.client.js';
import { WebhookService } from '../../../src/modules/payments/services/webhook/webhook.service.js';
import { WebhookSignatureError } from '../../../src/modules/payments/errors/payment.errors.js';

describe('Provider webhook signature verification (unit)', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ event: 'payment.succeeded', id: 'evt_1001' });

  describe('Razorpay — hex HMAC-SHA256 of the raw body', () => {
    it('accepts a correctly signed body and rejects a tampered one', () => {
      const validSig = createHmac('sha256', secret).update(body).digest('hex');
      assert.equal(verifyRazorpayWebhookSignature(body, validSig, secret), true);
      assert.equal(verifyRazorpayWebhookSignature(body, 'deadbeef', secret), false);
      assert.equal(verifyRazorpayWebhookSignature(body, validSig, 'wrong_secret'), false);
    });

    it('rejects an empty signature or secret rather than throwing', () => {
      assert.equal(verifyRazorpayWebhookSignature(body, '', secret), false);
      assert.equal(verifyRazorpayWebhookSignature(body, 'sig', ''), false);
    });
  });

  describe("Stripe — Stripe-Signature's t=/v1= scheme, never the generic HMAC-over-raw-body verifier", () => {
    it('accepts a correctly signed, fresh header', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${body}`;
      const v1 = createHmac('sha256', secret).update(signedPayload).digest('hex');
      const header = `t=${timestamp},v1=${v1}`;
      assert.equal(verifyStripeWebhookSignature(body, header, secret), true);
    });

    it('rejects a signature computed over the raw body alone (the old generic scheme)', () => {
      // Proves this is genuinely Stripe's real construction and not the
      // single HMAC-over-raw-body verifier every gateway used before this
      // change — that scheme's signature must NOT pass here.
      const genericSig = createHmac('sha256', secret).update(body).digest('hex');
      const timestamp = Math.floor(Date.now() / 1000);
      assert.equal(
        verifyStripeWebhookSignature(body, `t=${timestamp},v1=${genericSig}`, secret),
        false,
      );
    });

    it('accepts when ANY v1 signature matches (secret rotation carries multiple)', () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = `${timestamp}.${body}`;
      const correct = createHmac('sha256', secret).update(signedPayload).digest('hex');
      const header = `t=${timestamp},v1=deadbeef,v1=${correct}`;
      assert.equal(verifyStripeWebhookSignature(body, header, secret), true);
    });

    it('rejects a stale timestamp outside the tolerance window', () => {
      const staleTimestamp = Math.floor(Date.now() / 1000) - 10_000;
      const signedPayload = `${staleTimestamp}.${body}`;
      const v1 = createHmac('sha256', secret).update(signedPayload).digest('hex');
      const header = `t=${staleTimestamp},v1=${v1}`;
      assert.equal(verifyStripeWebhookSignature(body, header, secret, 300), false);
    });

    it('rejects a malformed header with no t= or v1=', () => {
      assert.equal(verifyStripeWebhookSignature(body, 'not-a-real-header', secret), false);
    });
  });

  describe('WebhookService.handleGatewayWebhook — rejects an invalid signature before any business effect', () => {
    it('throws WebhookSignatureError and never reaches the repository', async () => {
      const gatewayResolver = { webhookSecretFor: async () => secret } as never;
      const webhookRepo = {
        findOrPersist: () => {
          throw new Error('must not be called for an invalid signature');
        },
      } as never;
      const service = new WebhookService(
        webhookRepo,
        {} as never,
        gatewayResolver,
        {} as never,
        { webhookReceived: () => {}, webhookFailure: () => {} } as never,
      );

      await assert.rejects(
        () =>
          service.handleGatewayWebhook({
            gateway: 'razorpay',
            rawBody: body,
            signature: 'bad_signature',
            payload: { event: 'payment.succeeded' },
          }),
        WebhookSignatureError,
      );
    });

    it('rejects an unsupported gateway name', async () => {
      const gatewayResolver = { webhookSecretFor: async () => secret } as never;
      const service = new WebhookService(
        {} as never,
        {} as never,
        gatewayResolver,
        {} as never,
        { webhookReceived: () => {}, webhookFailure: () => {} } as never,
      );

      await assert.rejects(
        () =>
          service.handleGatewayWebhook({
            gateway: 'mock' as never,
            rawBody: body,
            signature: 'sig',
            payload: {},
          }),
        WebhookSignatureError,
      );
    });
  });
});
