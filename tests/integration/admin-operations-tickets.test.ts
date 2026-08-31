import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876546601';
const ADMIN_EMAIL = 'ops-tickets-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin operations support tickets (integration)', () => {
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
    await grantRole(seed.userId, 'admin');
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
      adminUserId: seed.userId,
    };
  }

  async function seedSupportFixture() {
    const client = db().client;
    const userPhone = `+91987654${Math.floor(1000 + Math.random() * 9000)}`;

    const user = await client.user.create({
      data: {
        phoneNumber: userPhone,
        status: 'ACTIVE',
        isPhoneVerified: true,
        profile: {
          create: {
            firstName: 'Amina',
            lastName: 'Customer',
          },
        },
      },
    });

    const category = await client.supportCategory.create({
      data: {
        code: `RIDE_TEST_${Math.floor(1000 + Math.random() * 9000)}`,
        name: 'Ride Fare Issue',
        defaultPriority: 'NORMAL',
        isActive: true,
      },
    });

    const agentUser = await client.user.create({
      data: {
        phoneNumber: `+91987654${Math.floor(1000 + Math.random() * 9000)}`,
        status: 'ACTIVE',
        isPhoneVerified: true,
        profile: {
          create: {
            firstName: 'Bilal',
            lastName: 'Support',
          },
        },
      },
    });

    const agent = await client.supportAgent.create({
      data: {
        userId: agentUser.id,
        displayName: 'Bilal Support Specialist',
        status: 'AVAILABLE',
        maxConcurrent: 10,
      },
    });

    const ticketNumber = `TKT-${Math.floor(100000 + Math.random() * 900000)}`;
    const ticket = await client.supportTicket.create({
      data: {
        ticketNumber,
        userId: user.id,
        categoryId: category.id,
        subject: 'Driver charged extra cash on arrival',
        description: 'Driver demanded extra 100 rupees beyond app fare.',
        status: 'OPEN',
        priority: 'HIGH',
        channel: 'APP',
      },
    });

    await client.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        authorType: 'CUSTOMER',
        authorId: user.id,
        body: 'Driver demanded extra 100 rupees beyond app fare.',
        isInternal: false,
      },
    });

    return { user, category, agent, ticket };
  }

  it('rejects unauthenticated requests to tickets endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/tickets',
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects users without operations:read permission', async () => {
    const regularUser = await loginAs(app, '+919876549911');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/tickets',
      headers: regularUser.authHeader,
    });
    assert.equal(res.statusCode, 403);
  });

  it('lists support tickets with pagination and filtering', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSupportFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/tickets?status=OPEN&priority=HIGH`,
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(Array.isArray(body.data), true);
    const item = body.data.find((t) => t.id === fixture.ticket.id);
    assert.ok(item);
    assert.equal(item.ticketNumber, fixture.ticket.ticketNumber);
    assert.equal(item.user.fullName, 'Amina Customer');
    assert.equal(item.category.name, 'Ride Fare Issue');
    assert.equal(item.status, 'OPEN');
    assert.equal(item.messagesCount, 1);
  });

  it('gets full support ticket details including messages and timeline', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSupportFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/tickets/${fixture.ticket.id}`,
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.equal(body.id, fixture.ticket.id);
    assert.equal(body.ticketNumber, fixture.ticket.ticketNumber);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].body, 'Driver demanded extra 100 rupees beyond app fare.');
  });

  it('creates a new support ticket', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSupportFixture();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operations/tickets',
      headers: { authorization: authHeader.authorization },
      payload: {
        userId: fixture.user.id,
        categoryId: fixture.category.id,
        subject: 'Lost umbrella in cab',
        description: 'Left a blue umbrella in the back seat.',
        priority: 'LOW',
        channel: 'PHONE',
      },
    });

    assert.equal(res.statusCode, 201, res.payload);
    const created = res.json().data;
    assert.equal(created.subject, 'Lost umbrella in cab');
    assert.equal(created.status, 'OPEN');
    assert.equal(created.priority, 'LOW');
    assert.equal(created.messages.length, 1);
  });

  it('assigns an agent to a ticket', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSupportFixture();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/tickets/${fixture.ticket.id}/assign`,
      headers: { authorization: authHeader.authorization },
      payload: {
        agentId: fixture.agent.id,
        reason: 'Assigned for priority investigation',
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const updated = res.json().data;
    assert.equal(updated.assignedAgent.id, fixture.agent.id);
    assert.equal(updated.status, 'IN_PROGRESS');
    assert.equal(updated.assignments.length, 1);
    assert.equal(updated.assignments[0].reason, 'Assigned for priority investigation');
  });

  it('updates ticket status and adds notes', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSupportFixture();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/operations/tickets/${fixture.ticket.id}/status`,
      headers: { authorization: authHeader.authorization },
      payload: {
        status: 'WAITING_CUSTOMER',
        notes: 'Contacted customer requesting UPI payment screenshot',
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const updated = res.json().data;
    assert.equal(updated.status, 'WAITING_CUSTOMER');
  });

  it('adds an internal note and public reply message', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSupportFixture();

    const msgRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/tickets/${fixture.ticket.id}/messages`,
      headers: { authorization: authHeader.authorization },
      payload: {
        body: 'We are investigating this incident with the driver partner.',
        isInternal: false,
        authorType: 'AGENT',
      },
    });

    assert.equal(msgRes.statusCode, 201, msgRes.payload);
    const updated = msgRes.json().data;
    assert.equal(updated.messages.length, 2);
    assert.equal(
      updated.messages[1].body,
      'We are investigating this incident with the driver partner.',
    );
    assert.equal(updated.messages[1].isInternal, false);
  });

  it('resolves a ticket with resolution notes', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSupportFixture();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/tickets/${fixture.ticket.id}/resolve`,
      headers: { authorization: authHeader.authorization },
      payload: {
        resolutionNotes: 'Refunded 100 INR to customer wallet and warned driver.',
        status: 'RESOLVED',
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const updated = res.json().data;
    assert.equal(updated.status, 'RESOLVED');
    assert.ok(updated.resolvedAt);
  });

  it('lists categories and agents', async () => {
    const authHeader = await loginAdmin();
    await seedSupportFixture();

    const catRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/tickets/categories',
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(catRes.statusCode, 200, catRes.payload);
    assert.equal(Array.isArray(catRes.json().data), true);
    assert.equal(catRes.json().data.length >= 1, true);

    const agentRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/tickets/agents',
      headers: { authorization: authHeader.authorization },
    });
    assert.equal(agentRes.statusCode, 200, agentRes.payload);
    assert.equal(Array.isArray(agentRes.json().data), true);
    assert.equal(agentRes.json().data.length >= 1, true);
  });
});
