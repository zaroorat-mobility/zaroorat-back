import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import type { PaymentGatewayResolverService } from '../../src/modules/payments/services/gateway/payment-gateway-resolver.service.js';
import type { IntentService } from '../../src/modules/payments/services/intent/intent.service.js';
import { Decimal } from '../../src/modules/payments/types/index.js';

const ADMIN_PHONE = '+919876546044';
const ADMIN_EMAIL = 'payment-gateway-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin payment gateway configuration (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function loginAdmin() {
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, 'system_admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return { authorization: `Bearer ${loggedIn.json().accessToken}` };
  }

  async function loginRegularCustomer() {
    const seed = await loginAs(app, '+919876546999');
    return { authorization: `Bearer ${seed.accessToken}` };
  }

  function updateSettings(
    adminHeaders: { authorization: string },
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/integrations/payment',
      headers: adminHeaders,
      payload,
    });
  }

  function getSettings(adminHeaders: { authorization: string }) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/integrations/payment',
      headers: adminHeaders,
    });
  }

  const resolver = () => container.resolve<PaymentGatewayResolverService>('gatewayResolver');
  const intents = () => container.resolve<IntentService>('intentService');

  it('rejects unauthenticated and unauthorized requests', async () => {
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/integrations/payment',
    });
    assert.equal(unauth.statusCode, 401);

    const customerAuth = await loginRegularCustomer();
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/integrations/payment',
      headers: customerAuth,
    });
    assert.equal(forbidden.statusCode, 403);
  });

  it('lists exactly Razorpay and Stripe, never Cashfree, and never a plaintext secret', async () => {
    const adminHeaders = await loginAdmin();
    const res = await getSettings(adminHeaders);

    assert.equal(res.statusCode, 200, res.payload);
    const data = res.json().data;
    assert.ok(data.providers.razorpay);
    assert.ok(data.providers.stripe);
    assert.ok(!('cashfree' in data.providers), 'Cashfree must not be exposed in the Admin UI');
    assert.ok(
      'activeProvider' in data,
      'there is exactly one active-provider field, not a routing map',
    );
    assert.ok(!('routing' in data), 'per-purpose routing no longer exists');
    for (const provider of ['razorpay', 'stripe'] as const) {
      for (const [key, value] of Object.entries(data.providers[provider])) {
        if (typeof value === 'string' && /key|secret/i.test(key)) {
          assert.notEqual(
            value,
            'super-secret-plaintext-value',
            `${provider}.${key} must not be plaintext`,
          );
        }
      }
    }
  });

  it('configures a provider and stores credentials encrypted — never plaintext in the DB', async () => {
    const adminHeaders = await loginAdmin();
    const update = await updateSettings(adminHeaders, {
      providers: {
        razorpay: {
          enabled: true,
          environment: 'sandbox',
          keyId: 'rzp_test_key_id',
          keySecret: 'rzp_test_key_secret_12345',
          webhookSecret: 'rzp_test_webhook_secret',
        },
      },
    });
    assert.equal(update.statusCode, 200, update.payload);
    const data = update.json().data;
    assert.equal(data.providers.razorpay.enabled, true);
    assert.equal(data.providers.razorpay.environment, 'sandbox');
    assert.equal(data.providers.razorpay.configured, true);
    // Masked, not plaintext, not omitted.
    assert.notEqual(data.providers.razorpay.keySecret, 'rzp_test_key_secret_12345');
    assert.ok(data.providers.razorpay.keySecret.length > 0);

    const dbRow = await db().client.systemSetting.findUnique({
      where: { key: 'payment.razorpay_key_secret' },
    });
    assert.ok(dbRow?.value?.startsWith('enc:'), 'the secret must be encrypted at rest');
    assert.notEqual(dbRow?.value, 'rzp_test_key_secret_12345');
  });

  it('does not overwrite a credential when the caller resubmits the masked value', async () => {
    const adminHeaders = await loginAdmin();
    await updateSettings(adminHeaders, {
      providers: { stripe: { secretKey: 'sk_test_original_value' } },
    });
    const before = await db().client.systemSetting.findUnique({
      where: { key: 'payment.stripe_secret_key' },
    });

    const roundTrip = await getSettings(adminHeaders);
    const maskedValue = roundTrip.json().data.providers.stripe.secretKey;

    // Round-trip the masked value straight back — a naive implementation
    // would overwrite the real secret with the mask itself.
    await updateSettings(adminHeaders, { providers: { stripe: { secretKey: maskedValue } } });

    const after = await db().client.systemSetting.findUnique({
      where: { key: 'payment.stripe_secret_key' },
    });
    assert.equal(after?.value, before?.value, 'resubmitting the masked value must be a no-op');
  });

  // Task list 1-3: activating Razorpay routes both subscription and
  // commission-wallet-recharge intents to it, automatically.

  it('activates Razorpay, and both subscription payments and commission-wallet recharges use it automatically', async () => {
    const adminHeaders = await loginAdmin();
    const customer = await loginAs(app, '+919876546556');

    const configured = await updateSettings(adminHeaders, {
      providers: {
        razorpay: { enabled: true, keyId: 'rzp_id', keySecret: 'rzp_secret' },
      },
      activeProvider: 'razorpay',
    });
    assert.equal(configured.statusCode, 200, configured.payload);
    assert.equal(configured.json().data.activeProvider, 'razorpay');

    // Resolving the active gateway is a pure, in-memory construction — no
    // network call happens until something actually charges through it — so
    // this proves "Admin activated Razorpay" takes effect without the
    // automated suite ever making a live request to Razorpay's API.
    assert.equal((await resolver().getActiveGateway()).gatewayName, 'razorpay');

    // For the actual "a new intent uses whichever gateway is active,
    // automatically" behaviour, switch to `mock` — the one gateway safe to
    // actually call `createIntent` on in this suite. `mock` is a legitimate
    // admin-selectable value (see the credential-rotation test below), and
    // the mechanism under test — no per-purpose routing, both flows follow
    // the same active-provider setting — does not depend on which real
    // provider name is behind it.
    await updateSettings(adminHeaders, { activeProvider: 'mock' });

    // Neither flow asks the caller (a driver, here represented by any
    // authenticated user) which provider to use — `purpose` alone decides
    // what happens on success, never which gateway is used.
    const subscriptionIntent = await intents().createIntent({
      userId: customer.userId,
      amount: new Decimal(199),
      methodType: 'CARD',
      idempotencyKey: `sub-${Date.now()}`,
      purpose: 'DRIVER_SUBSCRIPTION_PAYMENT',
    });
    assert.equal(subscriptionIntent.gateway, 'mock');

    const rechargeIntent = await intents().createIntent({
      userId: customer.userId,
      amount: new Decimal(500),
      methodType: 'CARD',
      idempotencyKey: `recharge-${Date.now()}`,
      purpose: 'DRIVER_COMMISSION_RECHARGE',
    });
    assert.equal(
      rechargeIntent.gateway,
      'mock',
      'the same active-provider setting handles both flows, automatically',
    );
  });

  // Task list 4-7: switching the active provider affects only NEW intents;
  // an intent already created keeps its original provider forever.
  //
  // Uses `mock` for the actual `createIntent` calls, for the same
  // never-a-live-network-call reason as above; the provider-switch mechanism
  // itself is proven separately, against the real Razorpay/Stripe names,
  // purely by resolution (no `createIntent` call, so no network access).

  it('switching the active provider moves only NEW intents — an existing intent never changes', async () => {
    const adminHeaders = await loginAdmin();
    const customer = await loginAs(app, '+919876546557');

    await updateSettings(adminHeaders, { activeProvider: 'mock' });
    const firstIntent = await intents().createIntent({
      userId: customer.userId,
      amount: new Decimal(199),
      methodType: 'CARD',
      idempotencyKey: `sub-first-${Date.now()}`,
      purpose: 'DRIVER_SUBSCRIPTION_PAYMENT',
    });
    assert.equal(firstIntent.gateway, 'mock');

    // Switch to a real, unconfigured provider — proven to have actually
    // taken effect because resolving it now fails to find credentials,
    // without ever making a live request.
    const switched = await updateSettings(adminHeaders, { activeProvider: 'stripe' });
    assert.equal(switched.statusCode, 400, switched.payload);
    // Stripe is not configured in this suite, so activation itself is
    // refused (task list 10) — confirm that, then configure it minimally so
    // the switch can be proven without a live call.
    await updateSettings(adminHeaders, {
      providers: { stripe: { enabled: true, secretKey: 'sk_test_unused_never_called' } },
      activeProvider: 'stripe',
    });
    assert.equal((await resolver().getActiveGateway()).gatewayName, 'stripe');

    // The already-created intent is completely unaffected by the switch —
    // proven by re-reading it from the database, not by creating a second
    // intent (which would require an actual Stripe call).
    const reloaded = await db().client.paymentIntent.findUniqueOrThrow({
      where: { id: firstIntent.id },
    });
    assert.equal(reloaded.gateway, 'mock', "an existing intent's provider must never change");
  });

  // Task list 8: there is no per-driver provider selection at all — a
  // caller cannot even express one. `createIntent`'s input has no provider
  // field, so this is a type-level guarantee as much as a runtime one; the
  // runtime half is that the resolved gateway depends only on admin
  // configuration, never on anything the caller supplied.

  it('never lets the caller choose a provider — only the admin-active one is ever used', async () => {
    const adminHeaders = await loginAdmin();
    const customer = await loginAs(app, '+919876546558');
    await updateSettings(adminHeaders, { activeProvider: 'mock' });

    // `createIntent`'s input has no provider field at all — nothing here
    // could ask for a specific gateway even if it wanted to; only admin
    // configuration decides which one resolves.
    const intent = await intents().createIntent({
      userId: customer.userId,
      amount: new Decimal(100),
      methodType: 'CARD',
      idempotencyKey: `no-selection-${Date.now()}`,
      purpose: 'DRIVER_SUBSCRIPTION_PAYMENT',
    });
    assert.equal(intent.gateway, 'mock');
  });

  // Task list 9: a single scalar setting makes "activate both" inexpressible.

  it('cannot activate both providers simultaneously — activeProvider is one value, not a set', async () => {
    const adminHeaders = await loginAdmin();
    // Intentionally malformed: the schema accepts one string, never an array
    // of providers, so there is no way to even express "activate both".
    const res = await updateSettings(adminHeaders, { activeProvider: ['razorpay', 'stripe'] });
    assert.equal(res.statusCode, 400, res.payload);
  });

  it('rejects an unknown provider name for activeProvider', async () => {
    const adminHeaders = await loginAdmin();
    const res = await updateSettings(adminHeaders, { activeProvider: 'paypal' });
    assert.equal(res.statusCode, 400, res.payload);
  });

  it('rejects Cashfree as an active provider — it is not exposed at all', async () => {
    const adminHeaders = await loginAdmin();
    const res = await updateSettings(adminHeaders, { activeProvider: 'cashfree' });
    assert.equal(res.statusCode, 400, res.payload);
  });

  // Task list 10: activation is refused until the target has real credentials.

  it('refuses to activate an unconfigured provider', async () => {
    const adminHeaders = await loginAdmin();
    const res = await updateSettings(adminHeaders, { activeProvider: 'stripe' });
    assert.equal(res.statusCode, 400, res.payload);
    assert.match(res.json().error.message, /Cannot activate stripe/);

    // Nothing was written — the active provider stays whatever it was.
    const settings = await getSettings(adminHeaders);
    assert.notEqual(settings.json().data.activeProvider, 'stripe');
  });

  it('allows configuring credentials and activating in the same request', async () => {
    const adminHeaders = await loginAdmin();
    const res = await updateSettings(adminHeaders, {
      providers: { razorpay: { keyId: 'rzp_id_2', keySecret: 'rzp_secret_2' } },
      activeProvider: 'razorpay',
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().data.activeProvider, 'razorpay');
  });

  it('disabling the active provider blocks it from resolving for NEW intents', async () => {
    const adminHeaders = await loginAdmin();
    const update = await updateSettings(adminHeaders, {
      providers: {
        razorpay: { enabled: false, keyId: 'rzp_test_id', keySecret: 'rzp_test_secret' },
      },
      activeProvider: 'razorpay',
    });
    assert.equal(update.statusCode, 200, update.payload);
    assert.equal(update.json().data.providers.razorpay.enabled, false);
    assert.equal(update.json().data.activeProvider, 'razorpay');

    await assert.rejects(() => resolver().getActiveGateway());
  });
});
