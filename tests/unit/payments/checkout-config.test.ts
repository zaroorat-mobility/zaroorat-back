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

const DEFAULT_METHODS = { upi: true, netbanking: true, wallet: true, card: false };
const COMPANY = { email: 'payments@zaroorat.example', methods: DEFAULT_METHODS };

function serviceWith(
  getActiveGateway: () => Promise<unknown>,
  driverCheckout: { email: string | null; methods: typeof DEFAULT_METHODS } = COMPANY,
) {
  return new IntentService(
    {} as never,
    { getActiveGateway, driverCheckoutSettings: async () => driverCheckout } as never,
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
      checkout: { provider: 'razorpay', keyId: 'rzp_test_AbCdEf123456', methods: DEFAULT_METHODS },
      checkoutError: null,
    });
    assert.ok(!JSON.stringify(view).includes(SECRET));
  });

  it("passes Admin's method switches through, UPI always on", async () => {
    const methods = { upi: true, netbanking: false, wallet: true, card: true };
    const view = await serviceWith(async () => razorpay('rzp_test_AbCdEf123456'), {
      ...COMPANY,
      methods,
    }).checkoutConfig();
    assert.deepEqual(view.checkout?.methods, methods);
  });

  it('reports PAYMENT_EMAIL_NOT_SET for Razorpay without a company email, since Razorpay refuses those payments', async () => {
    const view = await serviceWith(async () => razorpay('rzp_test_AbCdEf123456'), {
      ...COMPANY,
      email: null,
    }).checkoutConfig();
    assert.deepEqual(view, { checkout: null, checkoutError: { code: 'PAYMENT_EMAIL_NOT_SET' } });
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
