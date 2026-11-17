import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, makeDriver } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import type { AdminDriverService } from '../../src/modules/admin/driver-management/drivers/driver.service.js';

const ADMIN_PHONE = '+919876545091';
const ADMIN_EMAIL = 'wallet-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

/// An admin credit is a manual change to a balance that ride commission is
/// deducted from, so it has to take the same wallet-row lock the deduction
/// takes, and it has to say why it happened.
describe('admin commission wallet credit (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
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
    return {
      userId: seed.userId,
      authHeader: { authorization: `Bearer ${loggedIn.json().accessToken}` },
    };
  }

  async function commissionDriver(balance: number): Promise<string> {
    const user = await loginAs(app, '+919876545092');
    return makeDriver(user.userId, {
      paymentModel: 'COMMISSION',
      commissionWalletBalance: balance,
    });
  }

  async function balanceOf(driverId: string): Promise<number> {
    const wallet = await db().client.driverCommissionWallet.findUniqueOrThrow({
      where: { driverId },
    });
    return Number(wallet.balance);
  }

  it('refuses a credit without a reason, and stores the reason when given', async () => {
    const admin = await loginAdmin();
    const driverId = await commissionDriver(100);
    const url = `/api/v1/admin/drivers/${driverId}/wallet/topup`;

    const noReason = await app.inject({
      method: 'POST',
      url,
      headers: admin.authHeader,
      payload: { amount: 50 },
    });
    assert.equal(noReason.statusCode, 400, noReason.payload);
    assert.equal(await balanceOf(driverId), 100);

    const credited = await app.inject({
      method: 'POST',
      url,
      headers: admin.authHeader,
      payload: { amount: 50, notes: 'Cash recharge received at the Srinagar office' },
    });
    assert.equal(credited.statusCode, 200, credited.payload);
    assert.equal(await balanceOf(driverId), 150);
    const txn = await db().client.driverCommissionWalletTransaction.findFirstOrThrow({
      where: { driverId, txnType: 'ADMIN_CREDIT' },
    });
    assert.equal(txn.description, 'Cash recharge received at the Srinagar office');
    assert.equal(Number(txn.balanceAfter), 150);
  });

  it('does not undo a commission deduction that commits while the credit is waiting', async () => {
    const admin = await loginAdmin();
    const driverId = await commissionDriver(100);
    const service = container.resolve<AdminDriverService>('adminDriverService');

    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    // Stands in for `CommissionWalletService.deductInTx`: wallet row locked,
    // ₹20 deducted, committed a moment later.
    const deduction = db().client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "driver_commission_wallets" WHERE "driver_id" = ${driverId}::uuid FOR UPDATE`;
        markLocked();
        await new Promise((resolve) => setTimeout(resolve, 700));
        await tx.driverCommissionWallet.update({ where: { driverId }, data: { balance: 80 } });
      },
      { timeout: 15_000 },
    );
    await locked;
    const credit = service.topUpCommissionWallet(
      driverId,
      50,
      { actorId: admin.userId },
      'Goodwill credit during a deduction',
    );
    await Promise.all([deduction, credit]);

    // 100 − 20 + 50. Before the wallet lock this was 150: the credit read 100,
    // waited, and wrote 100 + 50 over the deduction.
    assert.equal(await balanceOf(driverId), 130);
  });
});
