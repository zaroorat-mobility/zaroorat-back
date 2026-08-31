import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';

const ADMIN_PHONE = '+919876547701';
const ADMIN_EMAIL = 'ops-safety-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin operations safety center & incidents (integration)', () => {
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

  async function seedSafetyFixture() {
    const client = db().client;
    const userPhone = `+91987654${Math.floor(1000 + Math.random() * 9000)}`;

    const reporter = await client.user.create({
      data: {
        phoneNumber: userPhone,
        status: 'ACTIVE',
        isPhoneVerified: true,
        profile: {
          create: {
            firstName: 'Zoya',
            lastName: 'Passenger',
          },
        },
      },
    });

    const incidentNumber = `SOS-${Math.floor(100000 + Math.random() * 900000)}`;
    const incident = await client.safetyIncident.create({
      data: {
        incidentNumber,
        type: 'SOS',
        severity: 'CRITICAL',
        status: 'OPEN',
        reporterUserId: reporter.id,
        latitude: 34.088,
        longitude: 74.821,
        locationAddress: 'Boulevard Road, Srinagar',
        description: 'Emergency SOS activated by rider.',
      },
    });

    await client.safetyIncidentEvent.create({
      data: {
        incidentId: incident.id,
        eventType: 'TRIGGERED',
        actorId: reporter.id,
        notes: 'SOS triggered via mobile app emergency button.',
      },
    });

    return { reporter, incident };
  }

  it('rejects unauthenticated requests to incidents endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/incidents',
    });
    assert.equal(res.statusCode, 401);
  });

  it('rejects users without operations:read permission', async () => {
    const regularUser = await loginAs(app, '+919876549922');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/operations/incidents',
      headers: regularUser.authHeader,
    });
    assert.equal(res.statusCode, 403);
  });

  it('lists safety incidents with filtering by status and severity', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSafetyFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/incidents?status=OPEN&severity=CRITICAL`,
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(Array.isArray(body.data), true);
    const item = body.data.find((inc) => inc.id === fixture.incident.id);
    assert.ok(item);
    assert.equal(item.incidentNumber, fixture.incident.incidentNumber);
    assert.equal(item.type, 'SOS');
    assert.equal(item.severity, 'CRITICAL');
    assert.equal(item.reporter.fullName, 'Zoya Passenger');
  });

  it('gets full safety incident details with event audit log', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSafetyFixture();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/operations/incidents/${fixture.incident.id}`,
      headers: { authorization: authHeader.authorization },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.equal(body.id, fixture.incident.id);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].eventType, 'TRIGGERED');
  });

  it('creates a new safety incident / mishap report', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSafetyFixture();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operations/incidents',
      headers: { authorization: authHeader.authorization },
      payload: {
        type: 'ACCIDENT',
        severity: 'MEDIUM',
        reporterUserId: fixture.reporter.id,
        locationAddress: 'Jawahar Nagar, Srinagar',
        description: 'Minor collision with stationary vehicle during pickup.',
      },
    });

    assert.equal(res.statusCode, 201, res.payload);
    const created = res.json().data;
    assert.equal(created.type, 'ACCIDENT');
    assert.equal(created.severity, 'MEDIUM');
    assert.equal(created.status, 'OPEN');
    assert.equal(created.events.length, 1);
  });

  it('acknowledges an active SOS incident', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSafetyFixture();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/incidents/${fixture.incident.id}/acknowledge`,
      headers: { authorization: authHeader.authorization },
      payload: {
        notes: 'Contacted PCR control room and nearest patrol car dispatched.',
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const updated = res.json().data;
    assert.equal(updated.status, 'ACKNOWLEDGED');
    assert.ok(updated.acknowledgedAt);
    assert.equal(updated.events.length, 2);
  });

  it('escalates incident severity and adds investigation note', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSafetyFixture();

    const escRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/incidents/${fixture.incident.id}/escalate`,
      headers: { authorization: authHeader.authorization },
      payload: {
        severity: 'CRITICAL',
        notes: 'Driver unreachable for 10 minutes on continuous attempts.',
      },
    });
    assert.equal(escRes.statusCode, 200, escRes.payload);
    assert.equal(escRes.json().data.severity, 'CRITICAL');
    assert.equal(escRes.json().data.status, 'INVESTIGATING');

    const noteRes = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/incidents/${fixture.incident.id}/notes`,
      headers: { authorization: authHeader.authorization },
      payload: {
        notes: 'Family emergency contact notified.',
      },
    });
    assert.equal(noteRes.statusCode, 200, noteRes.payload);
    assert.equal(noteRes.json().data.events.length, 3);
  });

  it('attaches evidence file to an incident', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSafetyFixture();
    const mockFileId = randomUUID();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/incidents/${fixture.incident.id}/evidence`,
      headers: { authorization: authHeader.authorization },
      payload: {
        fileId: mockFileId,
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const updated = res.json().data;
    assert.equal(updated.evidenceFileIds.includes(mockFileId), true);
  });

  it('resolves safety incident with resolution notes and status', async () => {
    const authHeader = await loginAdmin();
    const fixture = await seedSafetyFixture();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operations/incidents/${fixture.incident.id}/resolve`,
      headers: { authorization: authHeader.authorization },
      payload: {
        resolutionType: 'FALSE_ALARM',
        resolutionNotes:
          'Customer confirmed phone was accidentally triggered in pocket. Trip completed safely.',
        status: 'RESOLVED',
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const updated = res.json().data;
    assert.equal(updated.status, 'RESOLVED');
    assert.equal(updated.resolutionType, 'FALSE_ALARM');
    assert.ok(updated.resolvedAt);
  });
});
