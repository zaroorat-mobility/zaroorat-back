import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IntentService } from '../../../src/modules/payments/services/intent/intent.service.js';
import {
  PaymentGatewayDisabledError,
  PaymentGatewayNotConfiguredError,
} from '../../../src/modules/payments/services/gateway/payment-gateway-resolver.service.js';

// recharge-options `include=checkout` (driver inline payments): only the
// active gateway's PUBLIC key id ever leaves the backend.
const SECRET = 'very_secret_value_that_must_never_leave';

function serviceWith(getActiveGateway: () => Promise<unknown>) {
  return new IntentService(
    {} as never,
    { getActiveGateway } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const razorpay = (keyId: string) => ({
  gatewayName: 'razorpay',
  keySecret: SECRET,
  checkoutKeyId: () => keyId,
});

describe('checkout config for the Driver App (public key id only)', () => {
  it('returns the configured public key id and nothing secret', async () => {
    const view = await serviceWith(async () => razorpay('rzp_test_AbCdEf123456')).checkoutConfig();
    assert.deepEqual(view, {
      checkout: { provider: 'razorpay', keyId: 'rzp_test_AbCdEf123456' },
      checkoutError: null,
    });
    assert.ok(!JSON.stringify(view).includes(SECRET));
  });

  it('has no checkout and no error for a provider without client checkout (the dev mock)', async () => {
    const view = await serviceWith(async () => ({
      gatewayName: 'mock',
      checkoutKeyId: () => null,
    })).checkoutConfig();
    assert.deepEqual(view, { checkout: null, checkoutError: null });
  });

  it('reports missing or disabled configuration explicitly instead of inventing a key', async () => {
    assert.deepEqual(
      await serviceWith(async () => {
        throw new PaymentGatewayNotConfiguredError('razorpay');
      }).checkoutConfig(),
      { checkout: null, checkoutError: { code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' } },
    );
    assert.deepEqual(
      await serviceWith(async () => {
        throw new PaymentGatewayDisabledError('razorpay');
      }).checkoutConfig(),
      { checkout: null, checkoutError: { code: 'PAYMENT_GATEWAY_DISABLED' } },
    );
  });

  it('treats a value that is not a Razorpay public key id as not configured', async () => {
    for (const keyId of ['', 'not-a-key', SECRET, 'rzp_test_']) {
      const view = await serviceWith(async () => razorpay(keyId)).checkoutConfig();
      assert.deepEqual(view, {
        checkout: null,
        checkoutError: { code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' },
      });
      assert.ok(!JSON.stringify(view).includes(SECRET));
    }
  });

  it('lets an unexpected failure surface rather than reporting a configuration state', async () => {
    await assert.rejects(
      serviceWith(async () => {
        throw new Error('database down');
      }).checkoutConfig(),
      /database down/,
    );
  });
});
