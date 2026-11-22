import { FAKE_RAZORPAY_KEY_ID, FAKE_RAZORPAY_KEY_SECRET } from './helpers/razorpay-fake-env.js';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver, makeSubscriptionPlan } from './helpers/fixtures.js';

const API = 'https://api.razorpay.com/v1';

/// 005-razorpay-driver-payments T040 (TM-16) for T042 and T043, against the
/// real API, database, Razorpay adapter, signature check and validation gate.
/// Razorpay itself is an in-process stub of `fetch` with FAKE credentials
/// (helpers/razorpay-fake-env.ts): nothing leaves this process, and this is
/// not evidence of a real sandbox payment.
describe('driver checkout: payload, status and verify (integration)', () => {
  let app: FastifyInstance;
  let restoreFetch: () => void;
  type Entity = { id: string; order_id: string; amount: number; currency: string; status: string };
  const payments = new Map<string, Entity | 'UNAVAILABLE'>();
  const calls: string[] = [];
  /// While true, `POST /orders` answers 503, as an unreachable Razorpay would.
  let ordersUnavailable = false;
  /// Every order the stub actually created.
  const createdOrders: string[] = [];

  before(async () => {
    app = await bootApp();
    await resetState();
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith(API)) return original(url, init);
      const path = u.slice(API.length);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const reply = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'POST' && path === '/orders') {
        if (ordersUnavailable) return reply(503, { error: { code: 'SERVER_ERROR' } });
        const body = JSON.parse(String(init?.body)) as { amount: number; currency: string };
        const id = `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
        createdOrders.push(id);
        return reply(200, { id, status: 'created', amount: body.amount, currency: body.currency });
      }
      const m = path.match(/^\/payments\/(pay_[A-Za-z0-9]+)$/);
      if (method === 'GET' && m) {
        const p = payments.get(m[1]!);
        if (p === 'UNAVAILABLE') return reply(503, { error: { code: 'SERVER_ERROR' } });
        if (!p) return reply(404, { error: { code: 'BAD_REQUEST_ERROR' } });
        return reply(200, { entity: 'payment', ...p });
      }
      return reply(404, { error: { code: 'BAD_REQUEST_ERROR' } });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  });
  after(async () => {
    restoreFetch();
    await app.close();
  });
  afterEach(async () => {
    payments.clear();
    calls.length = 0;
    ordersUnavailable = false;
    createdOrders.length = 0;
    await resetState();
  });

  const payId = () => `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

  /// Admin's company checkout email (resetState clears payment settings).
  const COMPANY_EMAIL = 'payments@zaroorat.example';
  const setCompanyEmail = () =>
    db().client.systemSetting.create({
      data: {
        key: 'payment.razorpay.checkout_email',
        value: COMPANY_EMAIL,
        category: 'integrations.payment',
      },
    });
  const sign = (orderId: string, paymentId: string) =>
    createHmac('sha256', FAKE_RAZORPAY_KEY_SECRET!).update(`${orderId}|${paymentId}`).digest('hex');

  async function balance(driverId: string): Promise<number> {
    const w = await db().client.driverCommissionWallet.findUnique({ where: { driverId } });
    return w?.balance.toNumber() ?? 0;
  }

  async function commissionDriver(phone: string) {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true, paymentModel: 'COMMISSION' });
    const driver = await loginAs(app, phone);
    return { driver, driverId, initialBalance: await balance(driverId) };
  }

  async function recharge(driver: LoggedInUser, key: string = randomUUID()) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/driver-wallet/recharge',
      headers: { ...driver.authHeader, 'idempotency-key': key },
      payload: { amount: 500 },
    });
    assert.equal(res.statusCode, 200, res.payload);
    return res.json().data as {
      intentId: string;
      gatewayIntentId: string;
      checkout: Record<string, unknown> | null;
    };
  }

  const status = (user: LoggedInUser | null, intentId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/payments/intents/${intentId}`,
      ...(user ? { headers: user.authHeader } : {}),
    });

  const verify = (
    user: LoggedInUser,
    intentId: string,
    body: Record<string, string>,
    key: string = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/payments/intents/${intentId}/verify`,
      headers: { ...user.authHeader, 'idempotency-key': key },
      payload: body,
    });

  const callback = (orderId: string, paymentId: string) => ({
    razorpayPaymentId: paymentId,
    razorpayOrderId: orderId,
    razorpaySignature: sign(orderId, paymentId),
  });

  const capture = (orderId: string, amount = 50000, status = 'captured') => {
    const id = payId();
    payments.set(id, { id, order_id: orderId, amount, currency: 'INR', status });
    return id;
  };

  const intentStatus = async (intentId: string) =>
    (await db().client.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status;

  const rechargeCredits = (intentId: string) =>
    db().client.driverCommissionWalletTransaction.count({
      where: { txnType: 'MANUAL_RECHARGE', referenceId: intentId },
    });

  it("returns the checkout payload (T042): public key, our order, paise, no secret, the driver's own phone and the company email", async () => {
    await setCompanyEmail();
    const { driver } = await commissionDriver('+919876607101');
    const data = await recharge(driver);

    assert.deepEqual(data.checkout, {
      provider: 'razorpay',
      keyId: FAKE_RAZORPAY_KEY_ID,
      orderId: data.gatewayIntentId,
      amount: 50000,
      currency: 'INR',
      name: 'Zaroorat',
      description: 'Commission wallet recharge',
      // UD-9 (a): the caller's own login number, and nothing else about them;
      // the email is Admin's company address.
      prefill: { contact: '+919876607101', email: COMPANY_EMAIL },
    });
    const raw = JSON.stringify(data);
    assert.ok(!raw.includes(FAKE_RAZORPAY_KEY_SECRET!), 'the key secret never leaves the backend');
  });

  it('adds the public checkout key id to the recharge options on request, never the secret', async () => {
    await setCompanyEmail();
    const { driver } = await commissionDriver('+919876607121');
    const url = '/api/v1/payments/driver-wallet/recharge-options';

    const plain = await app.inject({ method: 'GET', url, headers: driver.authHeader });
    assert.equal(plain.statusCode, 200, plain.payload);
    assert.ok(Array.isArray(plain.json().data), 'older apps still receive the option list');

    const res = await app.inject({
      method: 'GET',
      url: `${url}?include=checkout`,
      headers: driver.authHeader,
    });
    assert.equal(res.statusCode, 200, res.payload);
    const data = res.json().data;
    assert.ok(Array.isArray(data.options));
    assert.deepEqual(data.checkout, {
      provider: 'razorpay',
      keyId: FAKE_RAZORPAY_KEY_ID,
      // Defaults: UPI always, net banking and wallets on, cards off until PCI DSS.
      methods: { upi: true, netbanking: true, wallet: true, card: false },
    });
    assert.equal(data.checkoutError, null);
    assert.ok(!res.payload.includes(FAKE_RAZORPAY_KEY_SECRET!), 'the key secret never leaves');
    assert.ok(!/secret/i.test(res.payload));
  });

  it('blocks driver checkout until Admin sets the company email, and passes method switches through', async () => {
    const { driver } = await commissionDriver('+919876607122');
    const config = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/payments/driver-wallet/recharge-options?include=checkout',
          headers: driver.authHeader,
        })
      ).json().data;

    const blocked = await config();
    assert.equal(blocked.checkout, null);
    assert.deepEqual(blocked.checkoutError, { code: 'PAYMENT_EMAIL_NOT_SET' });

    await setCompanyEmail();
    await db().client.systemSetting.createMany({
      data: [
        {
          key: 'payment.methods.netbanking_enabled',
          value: 'false',
          category: 'integrations.payment',
        },
        { key: 'payment.methods.card_enabled', value: 'true', category: 'integrations.payment' },
      ],
    });
    const open = await config();
    assert.equal(open.checkoutError, null);
    assert.deepEqual(open.checkout.methods, {
      upi: true,
      netbanking: false,
      wallet: true,
      card: true,
    });
  });

  it('rebuilds the checkout on a replay: same intent and order, current values', async () => {
    const { driver } = await commissionDriver('+919876607111');
    const key = randomUUID();
    const first = await recharge(driver, key);
    // Stands in for any value that changed after the first answer was stored,
    // like the phone prefill added after an attempt began.
    await db().client.user.update({
      where: { id: driver.userId },
      data: { phoneNumber: '+919876607198' },
    });
    const replay = await recharge(driver, key);

    assert.equal(replay.intentId, first.intentId);
    assert.equal(replay.gatewayIntentId, first.gatewayIntentId);
    assert.deepEqual(replay.checkout?.prefill, { contact: '+919876607198' });
  });

  it('shows the owner a database-only status; anyone else gets the missing-intent answer', async () => {
    const { driver } = await commissionDriver('+919876607102');
    const stranger = (await commissionDriver('+919876607103')).driver;
    const { intentId } = await recharge(driver);
    calls.length = 0;

    const own = await status(driver, intentId);
    assert.equal(own.statusCode, 200, own.payload);
    const view = own.json().data;
    assert.equal(view.status, 'PENDING');
    assert.equal(view.amount, 500);
    assert.equal(view.effect, null);
    assert.match(view.supportReference, /^PAY-[0-9A-F]{8}$/);
    assert.deepEqual(calls, [], 'status never calls the provider');

    const foreign = await status(stranger, intentId);
    const missingId = randomUUID();
    const missing = await status(stranger, missingId);
    assert.equal(foreign.statusCode, 404);
    const comparable = (body: { error: Record<string, unknown> }, id: string) => {
      const { requestId: _r, ...rest } = body.error;
      return { ...rest, message: String(rest.message).replaceAll(id, '<id>') };
    };
    assert.deepEqual(comparable(foreign.json(), intentId), comparable(missing.json(), missingId));
    assert.equal((await status(driver, 'not-a-uuid')).statusCode, 400);
    assert.equal((await status(null, intentId)).statusCode, 401);
  });

  it('credits exactly once for a verified capture, however often verify is repeated', async () => {
    const { driver, driverId, initialBalance } = await commissionDriver('+919876607104');
    const { intentId, gatewayIntentId } = await recharge(driver);
    const paymentId = capture(gatewayIntentId);
    const key = randomUUID();

    const first = await verify(driver, intentId, callback(gatewayIntentId, paymentId), key);
    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(first.json().data.status, 'SUCCEEDED');
    assert.deepEqual(first.json().data.effect, { walletBalance: initialBalance + 500 });

    const replay = await verify(driver, intentId, callback(gatewayIntentId, paymentId), key);
    assert.deepEqual(replay.json().data, first.json().data, 'same key replays the same answer');
    const again = await verify(driver, intentId, callback(gatewayIntentId, paymentId));
    assert.equal(again.json().data.status, 'SUCCEEDED');

    assert.equal(await rechargeCredits(intentId), 1);
    assert.equal(await balance(driverId), initialBalance + 500);
    const row = await db().client.paymentTransaction.findFirstOrThrow({
      where: { intentId, status: 'SUCCEEDED' },
    });
    assert.equal(row.gatewayTxnId, paymentId, 'the pay_ id is stored, never the order id');
  });

  it('rejects a callback naming another order before any provider call (R1)', async () => {
    const { driver, driverId, initialBalance } = await commissionDriver('+919876607105');
    const { intentId } = await recharge(driver);
    const otherOrder = `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    calls.length = 0;

    const res = await verify(driver, intentId, callback(otherOrder, payId()));
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'PAYMENT_ORDER_MISMATCH');
    assert.deepEqual(calls, []);
    assert.equal(await intentStatus(intentId), 'PENDING');
    assert.equal(await balance(driverId), initialBalance);
  });

  it('rejects a bad signature before any provider call', async () => {
    const { driver } = await commissionDriver('+919876607106');
    const { intentId, gatewayIntentId } = await recharge(driver);
    const paymentId = capture(gatewayIntentId);
    calls.length = 0;

    const res = await verify(driver, intentId, {
      ...callback(gatewayIntentId, paymentId),
      razorpaySignature: 'a'.repeat(64),
    });
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'PAYMENT_SIGNATURE_INVALID');
    assert.deepEqual(calls, []);
    assert.equal(await intentStatus(intentId), 'PENDING');
  });

  it('rejects a payment the provider says belongs to another order, with no change (R1)', async () => {
    const { driver, driverId, initialBalance } = await commissionDriver('+919876607107');
    const { intentId, gatewayIntentId } = await recharge(driver);
    const otherOrder = `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const paymentId = capture(otherOrder);

    // A genuine signature for OUR order over a payment of another order.
    const res = await verify(driver, intentId, callback(gatewayIntentId, paymentId));
    assert.equal(res.statusCode, 400, res.payload);
    assert.equal(res.json().error.code, 'PAYMENT_ORDER_MISMATCH');
    assert.equal(await intentStatus(intentId), 'PENDING');
    assert.equal(await balance(driverId), initialBalance);
    assert.equal(
      await db().client.paymentReviewCase.count(),
      0,
      'no case is opened on this intent',
    );
  });

  it('answers 503 and changes nothing when the provider is unavailable; 400 for an unknown payment', async () => {
    const { driver } = await commissionDriver('+919876607108');
    const { intentId, gatewayIntentId } = await recharge(driver);
    const down = payId();
    payments.set(down, 'UNAVAILABLE');

    const unavailable = await verify(driver, intentId, callback(gatewayIntentId, down));
    assert.equal(unavailable.statusCode, 503, unavailable.payload);
    assert.equal(unavailable.json().error.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    assert.equal(await intentStatus(intentId), 'PENDING', 'unknown is never failed (INV-8)');
    assert.equal(
      await db().client.paymentTransaction.count({ where: { intentId } }),
      0,
      'no payment record',
    );
    assert.equal(await db().client.paymentReviewCase.count(), 0, 'no review case');
    assert.equal(await rechargeCredits(intentId), 0, 'no wallet credit');

    const unknown = await verify(driver, intentId, callback(gatewayIntentId, payId()));
    assert.equal(unknown.statusCode, 400, unknown.payload);
    assert.equal(unknown.json().error.code, 'PAYMENT_ORDER_MISMATCH');
    assert.equal(await intentStatus(intentId), 'PENDING');
  });

  it('answers 503 and creates no intent when order creation fails; a same-key retry after recovery makes exactly one', async () => {
    const { driver } = await commissionDriver('+919876607113');
    const key = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/payments/driver-wallet/recharge',
        headers: { ...driver.authHeader, 'idempotency-key': key },
        payload: { amount: 500 },
      });
    const intents = () => db().client.paymentIntent.count({ where: { userId: driver.userId } });

    ordersUnavailable = true;
    const down = await send();
    assert.equal(down.statusCode, 503, down.payload);
    assert.equal(down.json().error.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    assert.equal(await intents(), 0, 'no intent for the failed attempt');
    assert.deepEqual(createdOrders, [], 'no order was created');

    ordersUnavailable = false;
    const retry = await send();
    assert.equal(retry.statusCode, 200, retry.payload);
    const replay = await send();
    assert.equal(replay.statusCode, 200, replay.payload);
    assert.equal(replay.json().data.intentId, retry.json().data.intentId, 'the same key replays');
    assert.equal(await intents(), 1, 'exactly one intent');
    assert.deepEqual(createdOrders, [retry.json().data.gatewayIntentId], 'exactly one order');
  });

  it('answers 503 from subscription purchase when order creation fails, and a same-key retry makes exactly one', async () => {
    const user = await loginAs(app, '+919876607114');
    await grantRole(user.userId, 'driver');
    const driverId = await makeDriver(user.userId, { verified: true, paymentModel: null });
    const driver = await loginAs(app, '+919876607114');
    const planId = await makeSubscriptionPlan({ billingPeriod: 'WEEKLY', price: 500 });
    const key = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/subscriptions',
        headers: { ...driver.authHeader, 'idempotency-key': key },
        payload: { planId },
      });
    const intents = () => db().client.paymentIntent.count({ where: { userId: driver.userId } });

    ordersUnavailable = true;
    const res = await send();
    assert.equal(res.statusCode, 503, res.payload);
    assert.equal(res.json().error.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
    assert.equal(await intents(), 0, 'no intent for the failed attempt');
    assert.deepEqual(createdOrders, []);

    // The failed attempt's PENDING_PAYMENT row is reused, never duplicated.
    ordersUnavailable = false;
    const retry = await send();
    assert.equal(retry.statusCode, 200, retry.payload);
    const replay = await send();
    assert.deepEqual(replay.json().data, retry.json().data, 'the same key replays');
    assert.equal(await intents(), 1, 'exactly one intent');
    assert.deepEqual(createdOrders, [retry.json().data.checkout.orderId], 'exactly one order');
    const subs = await db().client.driverSubscription.findMany({ where: { driverId } });
    assert.equal(subs.length, 1, 'exactly one subscription row');
    assert.equal(subs[0]!.paymentIntentId, retry.json().data.intentId);
  });

  it('keeps an authorized-only payment PENDING and credits nothing', async () => {
    const { driver, driverId, initialBalance } = await commissionDriver('+919876607109');
    const { intentId, gatewayIntentId } = await recharge(driver);
    const paymentId = capture(gatewayIntentId, 50000, 'authorized');

    const res = await verify(driver, intentId, callback(gatewayIntentId, paymentId));
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().data.status, 'PENDING');
    assert.equal(await balance(driverId), initialBalance);
  });

  it('holds a capture one paisa short for review and shows IN_REVIEW', async () => {
    const { driver, driverId, initialBalance } = await commissionDriver('+919876607110');
    const { intentId, gatewayIntentId } = await recharge(driver);
    const paymentId = capture(gatewayIntentId, 49999);

    const res = await verify(driver, intentId, callback(gatewayIntentId, paymentId));
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.json().data.status, 'IN_REVIEW');
    assert.equal(res.json().data.effect, null);
    assert.equal(await balance(driverId), initialBalance);
    assert.equal(await db().client.paymentReviewCase.count({ where: { intentId } }), 1);
  });

  it("refuses verify on another driver's intent like a missing one, and a malformed body", async () => {
    const { driver } = await commissionDriver('+919876607111');
    const stranger = (await commissionDriver('+919876607112')).driver;
    const { intentId, gatewayIntentId } = await recharge(driver);
    const paymentId = capture(gatewayIntentId);

    const foreign = await verify(stranger, intentId, callback(gatewayIntentId, paymentId));
    assert.equal(foreign.statusCode, 404, foreign.payload);
    assert.equal(foreign.json().error.code, 'PAYMENT_NOT_FOUND');
    assert.equal(await intentStatus(intentId), 'PENDING');

    const malformed = await verify(driver, intentId, { razorpayPaymentId: paymentId });
    assert.equal(malformed.statusCode, 400, malformed.payload);
  });
});
