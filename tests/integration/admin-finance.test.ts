import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import {
  grantRole,
  makeAssignedVehicle,
  makeDriver,
  makePaidTransaction,
  makeRide,
  makeRideRequest,
} from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545070';
const ADMIN_EMAIL = 'finance-ops-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';
const CUSTOMER_PHONE = '+919876545071';
const DRIVER_PHONE = '+919876545072';

describe('admin financial operations (integration)', () => {
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
      authorization: `Bearer ${loggedIn.json().accessToken}`,
      userId: seed.userId,
    };
  }

  async function loginFinanceRole() {
    const seed = await loginAs(app, '+919876545073');
    await grantRole(seed.userId, 'finance');
    const again = await loginAs(app, '+919876545073');
    return { authorization: `Bearer ${again.accessToken}`, userId: again.userId };
  }

  async function seedRideWorld() {
    const customer = await loginAs(app, CUSTOMER_PHONE);
    const driverUser = await loginAs(app, DRIVER_PHONE);
    await grantRole(driverUser.userId, 'driver');
    const driverId = await makeDriver(driverUser.userId, { verified: true });
    const { vehicleId, vehicleTypeId } = await makeAssignedVehicle(driverId);
    const requestId = await makeRideRequest(customer.userId, vehicleTypeId);
    const rideId = await makeRide({
      requestId,
      customerId: customer.userId,
      driverId,
      vehicleId,
      vehicleTypeId,
      status: 'COMPLETED',
    });
    await db().client.rideFare.create({
      data: {
        rideId,
        baseFare: 50,
        distanceFare: 80,
        timeFare: 20,
        subtotal: 150,
        taxAmount: 10,
        totalFare: 160,
        driverEarning: 140,
        platformCommission: 20,
      },
    });
    const paid = await makePaidTransaction(customer.userId, 160, {
      rideId,
      gateway: 'razorpay',
    });
    return { customer, driverId, rideId, ...paid };
  }

  it('rejects unauthenticated and unauthorized access to finance routes', async () => {
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/dashboard',
    });
    assert.equal(unauth.statusCode, 401);

    const customer = await loginAs(app, '+919876545074');
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/dashboard',
      headers: { authorization: `Bearer ${customer.accessToken}` },
    });
    assert.equal(forbidden.statusCode, 403);
  });

  it('allows finance role to read dashboard and transactions', async () => {
    await seedRideWorld();
    const finance = await loginFinanceRole();

    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/dashboard',
      headers: finance,
    });
    assert.equal(dashboard.statusCode, 200, dashboard.payload);
    const dash = dashboard.json().data;
    assert.ok(dash.revenue);
    assert.ok(dash.actions);
    assert.ok(dash.health);
    assert.ok(Array.isArray(dash.gateways));

    const txns = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/transactions',
      headers: finance,
    });
    assert.equal(txns.statusCode, 200, txns.payload);
    assert.ok(txns.json().data.length >= 1);
    assert.ok(txns.json().meta.totalCount >= 1);
  });

  it('returns transaction detail and reconciles variance status', async () => {
    const world = await seedRideWorld();
    const admin = await loginAdmin();

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/finance/transactions/${world.transactionId}`,
      headers: admin,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.id, world.transactionId);
    assert.equal(detail.json().data.status, 'captured');

    const reconcile = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/transactions/${world.transactionId}/reconcile`,
      headers: admin,
      payload: { varianceStatus: 'resolved', notes: 'Matched to gateway settlement' },
    });
    assert.equal(reconcile.statusCode, 200, reconcile.payload);
    assert.equal(reconcile.json().data.varianceStatus, 'resolved');
  });

  it('creates a refund from rideId and advances the review workflow', async () => {
    const world = await seedRideWorld();
    const admin = await loginAdmin();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/finance/refunds',
      headers: admin,
      payload: {
        rideId: world.rideId,
        riderId: world.customer.userId,
        riderName: 'Demo Rider',
        refundType: 'FARE_OVERCHARGED',
        requestedAmount: 40,
        reason: 'Rider overcharged due to route mismatch',
        refundSource: 'manual',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const refundId = created.json().data.id as string;
    assert.equal(created.json().data.status, 'requested');
    assert.ok(created.json().data.refundId.startsWith('REF-'));

    const review = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/refunds/${refundId}/start-review`,
      headers: admin,
      payload: { reviewerName: 'Finance Analyst' },
    });
    assert.equal(review.statusCode, 200, review.payload);
    assert.equal(review.json().data.status, 'under_review');

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/refunds/${refundId}/approve`,
      headers: admin,
      payload: {
        approvedAmount: 40,
        notes: 'Approved after ledger check',
        reviewerName: 'Finance Manager',
      },
    });
    assert.equal(approve.statusCode, 200, approve.payload);
    assert.equal(approve.json().data.status, 'approved');
    assert.equal(approve.json().data.approvedAmount, 40);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/refunds',
      headers: admin,
    });
    assert.equal(list.statusCode, 200, list.payload);
    assert.ok(list.json().data.some((r: { id: string }) => r.id === refundId));
  });

  it('rejects a refund and records timeline', async () => {
    const world = await seedRideWorld();
    const admin = await loginAdmin();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/finance/refunds',
      headers: admin,
      payload: {
        transactionId: world.transactionId,
        requestedAmount: 20,
        reason: 'Goodwill request',
        refundType: 'GOODWILL_COMPENSATION',
        refundSource: 'manual',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const refundId = created.json().data.id as string;

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/refunds/${refundId}/reject`,
      headers: admin,
      payload: { reason: 'Outside policy window', reviewerName: 'Finance Manager' },
    });
    assert.equal(rejected.statusCode, 200, rejected.payload);
    assert.equal(rejected.json().data.status, 'rejected');
    assert.ok(
      rejected.json().data.timeline.some((e: { action: string }) => e.action.includes('Reject')),
    );
  });

  it('creates, assigns, resolves, and closes a payment dispute', async () => {
    const world = await seedRideWorld();
    const admin = await loginAdmin();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/finance/disputes',
      headers: admin,
      payload: {
        rideId: world.rideId,
        type: 'FARE_DIFFERENCE',
        amount: 40,
        requestedAmount: 40,
        reason: 'Final fare exceeded estimate by ₹40',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const disputeId = created.json().data.id as string;
    assert.equal(created.json().data.status, 'open');

    const assigned = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/disputes/${disputeId}/assign`,
      headers: admin,
      payload: { agentName: 'Support Agent A' },
    });
    assert.equal(assigned.statusCode, 200, assigned.payload);
    assert.equal(assigned.json().data.status, 'assigned');
    assert.equal(assigned.json().data.assignedTo, 'Support Agent A');

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/disputes/${disputeId}/resolve`,
      headers: admin,
      payload: {
        resolutionType: 'Adjust Fare',
        resolutionNotes: 'Partial refund approved',
        adjustmentAmount: 40,
      },
    });
    assert.equal(resolved.statusCode, 200, resolved.payload);
    assert.equal(resolved.json().data.status, 'resolved');

    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/disputes/${disputeId}/close`,
      headers: admin,
      payload: { notes: 'Closed after rider confirmation' },
    });
    assert.equal(closed.statusCode, 200, closed.payload);
    assert.equal(closed.json().data.status, 'closed');
  });

  it('lists settlement batches and updates status', async () => {
    const world = await seedRideWorld();
    const admin = await loginAdmin();

    const periodEnd = new Date();
    periodEnd.setHours(0, 0, 0, 0);
    const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);

    const batch = await db().client.settlementBatch.create({
      data: {
        batchNumber: `SET-TEST-${randomUUID().slice(0, 6).toUpperCase()}`,
        periodStart,
        periodEnd,
        status: 'pending',
        generatedBy: 'Finance Manager',
        totalDrivers: 1,
        totalGrossAmount: 160,
        totalCommission: 20,
        totalNetPayable: 140,
        timeline: [
          {
            action: 'Batch Generated',
            actor: 'Finance Manager',
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });

    await db().client.driverSettlement.create({
      data: {
        driverId: world.driverId,
        periodStart,
        periodEnd,
        grossEarnings: 160,
        commission: 20,
        adjustments: 0,
        netPayable: 140,
        status: 'PENDING',
        settlementBatchId: batch.id,
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/settlements',
      headers: admin,
    });
    assert.equal(list.statusCode, 200, list.payload);
    assert.ok(list.json().data.some((b: { id: string }) => b.id === batch.id));

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/finance/settlements/${batch.id}`,
      headers: admin,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    assert.equal(detail.json().data.drivers.length, 1);

    const status = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/settlements/${batch.id}/status`,
      headers: admin,
      payload: { status: 'processing' },
    });
    assert.equal(status.statusCode, 200, status.payload);
    assert.equal(status.json().data.status, 'processing');
  });

  it('searches drivers and returns ledger entries', async () => {
    const world = await seedRideWorld();
    const admin = await loginAdmin();

    const wallet = await db().client.driverWallet.upsert({
      where: { driverId: world.driverId },
      update: { balance: 250 },
      create: { driverId: world.driverId, balance: 250, lockedBalance: 0 },
    });
    await db().client.driverWalletTransaction.create({
      data: {
        walletId: wallet.id,
        driverId: world.driverId,
        txnType: 'RIDE_EARNING',
        amount: 140,
        balanceAfter: 140,
        description: 'Completed ride earning',
      },
    });

    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/drivers/search?q=DRV',
      headers: admin,
    });
    assert.equal(search.statusCode, 200, search.payload);
    assert.ok(search.json().data.some((d: { driverId: string }) => d.driverId === world.driverId));

    const ledger = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/finance/drivers/${world.driverId}/ledger`,
      headers: admin,
    });
    assert.equal(ledger.statusCode, 200, ledger.payload);
    assert.ok(ledger.json().data.length >= 1);
    assert.equal(ledger.json().data[0].type, 'RIDE_EARNING');
  });

  it('returns finance audit logs after a mutating action', async () => {
    const world = await seedRideWorld();
    const admin = await loginAdmin();

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/finance/transactions/${world.transactionId}/reconcile`,
      headers: admin,
      payload: { varianceStatus: 'under_review' },
    });

    const logs = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/finance/audit-logs',
      headers: admin,
    });
    assert.equal(logs.statusCode, 200, logs.payload);
    assert.ok(logs.json().data.length >= 1);
  });
});
