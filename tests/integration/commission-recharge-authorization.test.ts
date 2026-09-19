import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';

const CUSTOMER = '+919876605001';
const ADMIN = '+919876605002';
const COMMISSION_DRIVER = '+919876605003';
const SUBSCRIPTION_DRIVER = '+919876605004';

/// Phase 1 — commission recharge authorization.
///
/// Commission credit is prepaid platform commission, so only a driver on the
/// COMMISSION model (or a SUBSCRIPTION driver whose switch to COMMISSION is
/// already staged) may buy it. Everyone else is refused BEFORE an idempotency
/// record or a gateway payment exists — previously any authenticated user
/// could pay, and the webhook then threw "no driver profile": money captured,
/// never credited.
describe('commission recharge authorization (integration, real HTTP)', () => {
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

  async function loginWithRole(phone: string, role: string): Promise<LoggedInUser> {
    const user = await loginAs(app, phone);
    await grantRole(user.userId, role);
    return loginAs(app, phone);
  }

  function recharge(user: LoggedInUser, key = randomUUID(), amount = 500) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/payments/driver-wallet/recharge',
      headers: { ...user.authHeader, 'idempotency-key': key },
      payload: { amount },
    });
  }

  async function intentsFor(userId: string) {
    return db().client.paymentIntent.findMany({ where: { userId } });
  }

  it('refuses a customer before any payment intent exists', async () => {
    const customer = await loginAs(app, CUSTOMER);

    const response = await recharge(customer);

    assert.equal(response.statusCode, 403, response.payload);
    assert.equal(response.json().error.code, 'COMMISSION_RECHARGE_NOT_ALLOWED');
    assert.equal((await intentsFor(customer.userId)).length, 0, 'no gateway payment was created');
  });

  it('refuses an admin who is not a driver', async () => {
    const admin = await loginWithRole(ADMIN, 'admin');

    const response = await recharge(admin);

    assert.equal(response.statusCode, 403, response.payload);
    assert.equal((await intentsFor(admin.userId)).length, 0);
  });

  it('refuses a subscription driver', async () => {
    const user = await loginWithRole(SUBSCRIPTION_DRIVER, 'driver');
    await makeDriver(user.userId, { verified: true, paymentModel: 'SUBSCRIPTION' });

    const response = await recharge(user);

    assert.equal(response.statusCode, 403, response.payload);
    assert.equal((await intentsFor(user.userId)).length, 0);
  });

  it('allows a subscription driver whose switch to COMMISSION is already staged', async () => {
    const user = await loginWithRole(SUBSCRIPTION_DRIVER, 'driver');
    const driverId = await makeDriver(user.userId, {
      verified: true,
      paymentModel: 'SUBSCRIPTION',
    });
    await db().client.driver.update({
      where: { id: driverId },
      data: { pendingPaymentModel: 'COMMISSION' },
    });

    const response = await recharge(user);

    assert.equal(response.statusCode, 200, response.payload);
    const [intent] = await intentsFor(user.userId);
    assert.equal(intent?.purpose, 'DRIVER_COMMISSION_RECHARGE');
  });

  it('accepts a commission driver, with the unchanged purpose and provider selection', async () => {
    const user = await loginWithRole(COMMISSION_DRIVER, 'driver');
    await makeDriver(user.userId, { verified: true, paymentModel: 'COMMISSION' });

    const response = await recharge(user);

    assert.equal(response.statusCode, 200, response.payload);
    const intents = await intentsFor(user.userId);
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.purpose, 'DRIVER_COMMISSION_RECHARGE');
    assert.equal(intents[0]?.gateway, response.json().data.gateway, 'the admin-selected provider');
  });

  it('replays a duplicate request with the same key instead of paying twice', async () => {
    const user = await loginWithRole(COMMISSION_DRIVER, 'driver');
    await makeDriver(user.userId, { verified: true, paymentModel: 'COMMISSION' });
    const key = randomUUID();

    const first = await recharge(user, key);
    const second = await recharge(user, key);

    assert.equal(first.statusCode, 200, first.payload);
    assert.equal(second.statusCode, 200, second.payload);
    assert.equal(second.json().data.intentId, first.json().data.intentId);
    assert.equal((await intentsFor(user.userId)).length, 1);
  });

  it('creates exactly one payment for concurrent requests sharing a key', async () => {
    const user = await loginWithRole(COMMISSION_DRIVER, 'driver');
    await makeDriver(user.userId, { verified: true, paymentModel: 'COMMISSION' });
    const key = randomUUID();

    const results = await Promise.all([
      recharge(user, key),
      recharge(user, key),
      recharge(user, key),
    ]);

    for (const r of results) {
      assert.ok(
        r.statusCode === 200 ||
          (r.statusCode === 409 && r.json().error.code === 'IDEMPOTENCY_IN_PROGRESS'),
        `a same-key request is the winner, a replay, or refused as in-flight: ${r.payload}`,
      );
    }
    assert.equal((await intentsFor(user.userId)).length, 1, 'one gateway payment, not three');
  });
});
