import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole, seedBillingInvoiceFixtures } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876545010';
const ADMIN_EMAIL = 'billing-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin billing invoices (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });

  after(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState();
    await seedBillingInvoiceFixtures();
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

  it('lists billing invoices for seeded demo riders and drivers', async () => {
    const auth = await loginAdmin();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/invoices',
      headers: auth,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: Array<{ invoiceNumber: string; recipientType: string; bookingId: string | null }>;
    };
    assert.equal(body.data.length, 2);

    const riderInvoice = body.data.find((row) => row.invoiceNumber === 'INV-TEST-001');
    assert.ok(riderInvoice);
    assert.equal(riderInvoice.recipientType, 'rider');
    assert.equal(riderInvoice.bookingId, 'R-9812');
  });

  it('lists invoice templates', async () => {
    const auth = await loginAdmin();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/invoice-templates',
      headers: auth,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: Array<{ name: string; isDefault: boolean }> };
    assert.ok(body.data.some((tpl) => tpl.name === 'Standard Ride Invoice Template'));
    assert.ok(body.data.some((tpl) => tpl.isDefault));
  });

  it('filters invoices by recipient type', async () => {
    const auth = await loginAdmin();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/invoices?recipientType=driver',
      headers: auth,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: Array<{ recipientType: string }> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.recipientType, 'driver');
  });
});
