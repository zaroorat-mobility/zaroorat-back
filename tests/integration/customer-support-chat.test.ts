import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';

describe('customer support chat (integration)', () => {
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

  async function seedCategory() {
    return db().client.supportCategory.create({
      data: {
        code: `RIDE_ISSUE_${randomUUID().slice(0, 6).toUpperCase()}`,
        name: 'Ride Issue',
        defaultPriority: 'NORMAL',
        isActive: true,
      },
    });
  }

  it('rejects unauthenticated chat reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/support/tickets',
    });
    assert.equal(res.statusCode, 401);
  });

  it('creates a ticket, hides internal notes, and accepts customer replies', async () => {
    const customer = await loginAs(app, '+919876541111');
    const other = await loginAs(app, '+919876541112');
    const category = await seedCategory();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      headers: customer.authHeader,
      payload: {
        subject: 'Trip and Booking',
        description: 'Need help with a fare',
        category: category.code,
        channel: 'CHAT',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const ticketId = created.json().data.id as string;

    await db().client.supportTicketMessage.create({
      data: {
        ticketId,
        authorType: 'AGENT',
        body: 'Internal note only',
        isInternal: true,
      },
    });
    await db().client.supportTicketMessage.create({
      data: {
        ticketId,
        authorType: 'AGENT',
        body: 'We are looking into this',
        isInternal: false,
      },
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/support/tickets/${ticketId}`,
      headers: customer.authHeader,
    });
    assert.equal(detail.statusCode, 200, detail.payload);
    const bodies = detail.json().data.messages.map((m: { body: string }) => m.body);
    assert.ok(bodies.includes('Need help with a fare'));
    assert.ok(bodies.includes('We are looking into this'));
    assert.ok(!bodies.includes('Internal note only'));

    const leaked = await app.inject({
      method: 'GET',
      url: `/api/v1/support/tickets/${ticketId}`,
      headers: other.authHeader,
    });
    assert.equal(leaked.statusCode, 404);

    await db().client.supportTicket.update({
      where: { id: ticketId },
      data: { status: 'WAITING_CUSTOMER' },
    });

    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/messages`,
      headers: customer.authHeader,
      payload: { body: 'Thanks, here are more details' },
    });
    assert.equal(sent.statusCode, 201, sent.payload);
    assert.equal(sent.json().data.body, 'Thanks, here are more details');

    const after = await db().client.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });
    assert.equal(after.status, 'IN_PROGRESS');

    await db().client.supportTicket.update({
      where: { id: ticketId },
      data: { status: 'CLOSED' },
    });
    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/messages`,
      headers: customer.authHeader,
      payload: { body: 'still here?' },
    });
    assert.equal(closed.statusCode, 409);
  });

  it('lists only the caller tickets and active categories', async () => {
    const customer = await loginAs(app, '+919876541113');
    await seedCategory();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      headers: customer.authHeader,
      payload: { subject: 'General Help', description: 'Need help' },
    });
    assert.equal(created.statusCode, 201, created.payload);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/support/tickets',
      headers: customer.authHeader,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.length, 1);

    const categories = await app.inject({
      method: 'GET',
      url: '/api/v1/support/categories',
      headers: customer.authHeader,
    });
    assert.equal(categories.statusCode, 200);
    assert.ok(Array.isArray(categories.json().data));
    assert.ok(categories.json().data.length >= 1);
  });
});
