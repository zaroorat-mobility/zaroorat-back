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

/// Feature 002 knobs. Each governs money or a money-adjacent policy, so each
/// must fail at boot rather than degrade silently: `Number('abc')` is NaN, and
/// every comparison against NaN is false, so an unvalidated knob fails *open*.
const V2_KEYS = [
  'PAYMENT_COLLECTION_MAX_ATTEMPTS',
  'PAYMENT_COLLECTION_RETRY_BASE_SEC',
  'PAYMENT_RIDER_DEBT_LIMIT',
  'PAYMENT_CASH_CONFIRMATION_REQUIRED',
  'PAYMENT_CASH_CONFIRM_GRACE_SEC',
  'PAYMENT_RECEIVABLE_WRITEOFF_DAYS',
  'PAYMENT_LEDGER_CUTOVER_AT',
  'PAYMENT_IDEMPOTENCY_TTL',
  'PAYMENT_WEBHOOK_TOLERANCE_SEC',
] as const;

const savedV2 = new Map<string, string | undefined>();

function setV2(key: string, value: string | undefined): void {
  if (!savedV2.has(key)) savedV2.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of savedV2) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedV2.clear();
});

describe('Payment configuration — collection & receivable knobs', () => {
  for (const key of V2_KEYS) {
    if (key === 'PAYMENT_CASH_CONFIRMATION_REQUIRED' || key === 'PAYMENT_LEDGER_CUTOVER_AT') {
      continue;
    }
    it(`refuses a non-numeric ${key} instead of yielding NaN`, () => {
      setV2(key, '3x');
      assert.throws(() => getPaymentConfig(), /Invalid configuration/);
    });
  }

  it('refuses an attempt cap of zero, which would collect nothing', () => {
    setV2('PAYMENT_COLLECTION_MAX_ATTEMPTS', '0');
    assert.throws(() => getPaymentConfig(), /at least 1/);
  });

  it('caps the attempt count, so no value can produce an unbounded retry loop', () => {
    setV2('PAYMENT_COLLECTION_MAX_ATTEMPTS', '5000');
    assert.throws(() => getPaymentConfig(), /at most 20/);
  });

  it('refuses a negative rider debt limit', () => {
    setV2('PAYMENT_RIDER_DEBT_LIMIT', '-1');
    assert.throws(() => getPaymentConfig(), /at least 0/);
  });

  it('refuses a write-off period of zero days', () => {
    setV2('PAYMENT_RECEIVABLE_WRITEOFF_DAYS', '0');
    assert.throws(() => getPaymentConfig(), /at least 1/);
  });

  it('reads valid values', () => {
    setV2('PAYMENT_COLLECTION_MAX_ATTEMPTS', '7');
    setV2('PAYMENT_RIDER_DEBT_LIMIT', '250.50');
    setV2('PAYMENT_RECEIVABLE_WRITEOFF_DAYS', '30');
    const cfg = getPaymentConfig();
    assert.equal(cfg.collectionMaxAttempts, 7);
    assert.equal(cfg.riderDebtLimit, 250.5);
    assert.equal(cfg.receivableWriteOffDays, 30);
  });
});

describe('Payment configuration — cash confirmation flag (BD-5)', () => {
  /// BD-5 approved this as feature-flagged and DEFAULT OFF. The house idiom
  /// `!== 'false'` defaults ON, so using it here would silently invert an
  /// approved business decision. These cases pin the direction.
  it('defaults to OFF when the variable is absent', () => {
    setV2('PAYMENT_CASH_CONFIRMATION_REQUIRED', undefined);
    assert.equal(getPaymentConfig().cashConfirmationRequired, false);
  });

  it('stays OFF for the literal string "false"', () => {
    setV2('PAYMENT_CASH_CONFIRMATION_REQUIRED', 'false');
    assert.equal(getPaymentConfig().cashConfirmationRequired, false);
  });

  it('stays OFF for any value that is not exactly "true"', () => {
    for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
      setV2('PAYMENT_CASH_CONFIRMATION_REQUIRED', value);
      assert.equal(
        getPaymentConfig().cashConfirmationRequired,
        false,
        `${JSON.stringify(value)} must not enable cash confirmation`,
      );
    }
  });

  it('turns ON only for exactly "true"', () => {
    setV2('PAYMENT_CASH_CONFIRMATION_REQUIRED', 'true');
    assert.equal(getPaymentConfig().cashConfirmationRequired, true);
  });
});

describe('Payment configuration — ledger cut-over (BD-7)', () => {
  it('refuses an unparseable timestamp rather than silently disabling the boundary', () => {
    setV2('PAYMENT_LEDGER_CUTOVER_AT', 'not-a-date');
    assert.throws(() => getPaymentConfig(), /PAYMENT_LEDGER_CUTOVER_AT/);
  });

  it('reads a valid ISO-8601 instant', () => {
    setV2('PAYMENT_LEDGER_CUTOVER_AT', '2026-08-23T00:00:00.000Z');
    assert.equal(getPaymentConfig().ledgerCutoverAt.toISOString(), '2026-08-23T00:00:00.000Z');
  });

  it('cuts over from process start when the variable is absent', () => {
    setV2('PAYMENT_LEDGER_CUTOVER_AT', undefined);
    const before = Date.now();
    const cutover = getPaymentConfig().ledgerCutoverAt.getTime();
    assert.ok(cutover >= before - 1000 && cutover <= Date.now() + 1000);
  });
});
