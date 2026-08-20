import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import {
  getPaymentConfig,
  MOCK_WEBHOOK_SECRET,
} from '../../../src/config/payment/payment.config.js';

const ENV_KEYS = ['PAYMENT_DEFAULT_GATEWAY', 'PAYMENT_WEBHOOK_SECRET'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('Payment configuration — webhook secret', () => {
  it('FAILS to build for a live gateway with no webhook secret', () => {
    setEnv({ PAYMENT_DEFAULT_GATEWAY: 'razorpay', PAYMENT_WEBHOOK_SECRET: undefined });
    assert.throws(() => getPaymentConfig(), /PAYMENT_WEBHOOK_SECRET is required/);
  });

  it('FAILS for a live gateway with a blank webhook secret', () => {
    setEnv({ PAYMENT_DEFAULT_GATEWAY: 'stripe', PAYMENT_WEBHOOK_SECRET: '   ' });
    assert.throws(() => getPaymentConfig(), /PAYMENT_WEBHOOK_SECRET is required/);
  });

  it('accepts a live gateway with a real secret', () => {
    setEnv({ PAYMENT_DEFAULT_GATEWAY: 'razorpay', PAYMENT_WEBHOOK_SECRET: 'whsec_from_dashboard' });
    const config = getPaymentConfig();
    assert.equal(config.defaultGateway, 'razorpay');
    assert.equal(config.webhookSecret, 'whsec_from_dashboard');
  });

  it('allows the mock gateway to run without a configured secret', () => {
    setEnv({ PAYMENT_DEFAULT_GATEWAY: 'mock', PAYMENT_WEBHOOK_SECRET: undefined });
    const config = getPaymentConfig();
    assert.equal(config.webhookSecret, MOCK_WEBHOOK_SECRET);
  });

  it('never hands the mock secret to a live gateway', () => {
    for (const gateway of ['razorpay', 'stripe']) {
      setEnv({ PAYMENT_DEFAULT_GATEWAY: gateway, PAYMENT_WEBHOOK_SECRET: 'real_secret' });
      assert.notEqual(getPaymentConfig().webhookSecret, MOCK_WEBHOOK_SECRET);
    }
  });

  it('rejects an unknown gateway name rather than defaulting', () => {
    setEnv({ PAYMENT_DEFAULT_GATEWAY: 'paypal', PAYMENT_WEBHOOK_SECRET: 'x' });
    assert.throws(() => getPaymentConfig(), /PAYMENT_DEFAULT_GATEWAY must be one of/);
  });

  it('exposes a finite replay tolerance', () => {
    setEnv({ PAYMENT_DEFAULT_GATEWAY: 'mock', PAYMENT_WEBHOOK_SECRET: undefined });
    const config = getPaymentConfig();
    assert.ok(config.webhookToleranceSeconds > 0);
    assert.ok(config.webhookToleranceSeconds <= 900);
  });
});
