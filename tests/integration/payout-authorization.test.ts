import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver, makeSettlement } from './helpers/fixtures.js';
import { Decimal } from '../../src/modules/payments/types/index.js';

const FINANCE = '+919876602001';
const DRIVER = '+919876602002';
const OTHER_DRIVER = '+919876602003';
const CUSTOMER = '+919876602004';

describe('driver payout authorization (integration, real HTTP)', () => {
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

  function payout(
    user: LoggedInUser,
    body: Record<string, unknown>,
    idempotencyKey = randomUUID(),
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/payments/payouts',
      headers: { ...user.authHeader, 'idempotency-key': idempotencyKey },
      payload: body,
    });
  }

  async function paidTotal(driverId: string): Promise<number> {
    const aggregate = await db().client.driverPayout.aggregate({
      where: { driverId, status: { not: 'FAILED' } },
      _sum: { amount: true },
    });
    return Number((aggregate._sum.amount ?? new Decimal(0)).toFixed(2));
  }

  async function seed(netPayable: number) {
    const finance = await loginWithRole(FINANCE, 'finance');
    const driverUser = await loginWithRole(DRIVER, 'driver');
    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const settlementId = await makeSettlement(driverId, netPayable);
    return { finance, driverId, settlementId };
  }

  describe('amount is bounded by the settlement', () => {
    it('allows a payout within the available balance', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await payout(finance, { driverId, settlementId, amount: 400 });

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(await paidTotal(driverId), 400);
    });

    it('allows a payout exactly equal to the available balance', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await payout(finance, { driverId, settlementId, amount: 1000 });

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(await paidTotal(driverId), 1000);
    });

    it('marks the settlement PAID only when nothing is left', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      await payout(finance, { driverId, settlementId, amount: 400 });
      let row = await db().client.driverSettlement.findUniqueOrThrow({
        where: { id: settlementId },
      });
      assert.equal(row.status, 'PENDING', 'a partial payout does not settle the period');

      await payout(finance, { driverId, settlementId, amount: 600 });
      row = await db().client.driverSettlement.findUniqueOrThrow({ where: { id: settlementId } });
      assert.equal(row.status, 'PAID');
    });

    it('rejects a payout greater than the available balance', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await payout(finance, { driverId, settlementId, amount: 1000.01 });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_EXCEEDS_AVAILABLE');
      assert.equal(await paidTotal(driverId), 0, 'nothing was written');
    });

    it('rejects the remainder once part of the balance is spent', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      assert.equal(
        (await payout(finance, { driverId, settlementId, amount: 700 })).statusCode,
        200,
      );

      const response = await payout(finance, { driverId, settlementId, amount: 400 });
      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(await paidTotal(driverId), 700, 'only the first payout stands');
    });

    it('refuses a payout with no settlement to bound it', async () => {
      const { finance, driverId } = await seed(1000);

      const response = await payout(finance, { driverId, amount: 100 });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(response.json().error.code, 'PAYOUT_UNBACKED');
      assert.equal(await paidTotal(driverId), 0);
    });

    it('refuses a settlement belonging to a different driver', async () => {
      const { finance, settlementId } = await seed(1000);
      const otherUser = await loginWithRole(OTHER_DRIVER, 'driver');
      const otherDriverId = await makeDriver(otherUser.userId, { verified: true });

      const response = await payout(finance, {
        driverId: otherDriverId,
        settlementId,
        amount: 500,
      });

      assert.equal(response.statusCode, 422, response.payload);
      assert.equal(await paidTotal(otherDriverId), 0);
    });
  });

  describe('amount validity', () => {
    it('rejects a zero payout', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await payout(finance, { driverId, settlementId, amount: 0 });
      assert.notEqual(response.statusCode, 200, response.payload);
      assert.equal(await paidTotal(driverId), 0);
    });

    it('rejects a negative payout', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await payout(finance, { driverId, settlementId, amount: -500 });
      assert.notEqual(response.statusCode, 200, response.payload);
      assert.equal(await paidTotal(driverId), 0);
    });

    it('handles decimal precision without drifting over the balance', async () => {
      const { finance, driverId, settlementId } = await seed(100.05);

      assert.equal(
        (await payout(finance, { driverId, settlementId, amount: 33.35 })).statusCode,
        200,
      );
      assert.equal(
        (await payout(finance, { driverId, settlementId, amount: 33.35 })).statusCode,
        200,
      );
      assert.equal(
        (await payout(finance, { driverId, settlementId, amount: 33.35 })).statusCode,
        200,
      );

      assert.equal(await paidTotal(driverId), 100.05);

      const overspend = await payout(finance, { driverId, settlementId, amount: 0.01 });
      assert.equal(overspend.statusCode, 422, 'the balance is exhausted to the paise');
    });
  });

  describe('idempotency', () => {
    it('returns the same payout for a repeated key, without paying twice', async () => {
      const { finance, driverId, settlementId } = await seed(1000);
      const key = randomUUID();

      const first = await payout(finance, { driverId, settlementId, amount: 300 }, key);
      const second = await payout(finance, { driverId, settlementId, amount: 300 }, key);

      assert.equal(first.statusCode, 200, first.payload);
      assert.equal(second.statusCode, 200, second.payload);
      assert.equal(await paidTotal(driverId), 300, 'exactly one payout of 300');
      assert.equal(await db().client.driverPayout.count({ where: { driverId } }), 1);
    });

    it('rejects a NEW key once the balance is already consumed', async () => {
      const { finance, driverId, settlementId } = await seed(500);

      assert.equal(
        (await payout(finance, { driverId, settlementId, amount: 500 })).statusCode,
        200,
      );

      const again = await payout(finance, { driverId, settlementId, amount: 500 });
      assert.equal(again.statusCode, 422, again.payload);
      assert.equal(await paidTotal(driverId), 500);
    });

    it('produces exactly one payout for concurrent requests sharing a key', async () => {
      const { finance, driverId, settlementId } = await seed(1000);
      const key = randomUUID();

      await Promise.all([
        payout(finance, { driverId, settlementId, amount: 250 }, key),
        payout(finance, { driverId, settlementId, amount: 250 }, key),
        payout(finance, { driverId, settlementId, amount: 250 }, key),
      ]);

      assert.equal(await db().client.driverPayout.count({ where: { driverId } }), 1);
      assert.equal(await paidTotal(driverId), 250);
    });
  });

  describe('concurrency', () => {
    it('cannot double-spend one balance across distinct keys', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      await Promise.all([
        payout(finance, { driverId, settlementId, amount: 1000 }),
        payout(finance, { driverId, settlementId, amount: 1000 }),
      ]);

      assert.equal(await paidTotal(driverId), 1000, 'the balance is spent once, not twice');
    });

    it('admits only as many concurrent payouts as the balance covers', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const results = await Promise.all(
        Array.from({ length: 6 }, () => payout(finance, { driverId, settlementId, amount: 400 })),
      );

      const accepted = results.filter((r) => r.statusCode === 200).length;
      assert.equal(accepted, 2, 'two × 400 fits in 1000; a third does not');
      assert.equal(await paidTotal(driverId), 800);
    });
  });

  describe('authorization', () => {
    it('refuses an unauthenticated caller', async () => {
      const { driverId, settlementId } = await seed(1000);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/payouts',
        headers: { 'idempotency-key': randomUUID() },
        payload: { driverId, settlementId, amount: 100 },
      });

      assert.equal(response.statusCode, 401, response.payload);
      assert.equal(await paidTotal(driverId), 0);
    });

    it('refuses a customer', async () => {
      const { driverId, settlementId } = await seed(1000);
      const customer = await loginAs(app, CUSTOMER);

      const response = await payout(customer, { driverId, settlementId, amount: 100 });
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(await paidTotal(driverId), 0);
    });

    it('refuses the driver being paid', async () => {
      const { driverId, settlementId } = await seed(1000);
      const driverUser = await loginAs(app, DRIVER);

      const response = await payout(driverUser, { driverId, settlementId, amount: 100 });
      assert.equal(response.statusCode, 403, response.payload);
      assert.equal(await paidTotal(driverId), 0);
    });

    it('allows an admin as well as finance', async () => {
      const { driverId, settlementId } = await seed(1000);
      const admin = await loginWithRole('+919876602005', 'admin');

      const response = await payout(admin, { driverId, settlementId, amount: 100 });
      assert.equal(response.statusCode, 200, response.payload);
    });

    it('requires an Idempotency-Key', async () => {
      const { finance, driverId, settlementId } = await seed(1000);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/payments/payouts',
        headers: finance.authHeader,
        payload: { driverId, settlementId, amount: 100 },
      });

      assert.equal(response.statusCode, 400, response.payload);
      assert.equal(response.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
      assert.equal(await paidTotal(driverId), 0);
    });
  });
});
