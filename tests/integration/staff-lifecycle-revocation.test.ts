import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { container } from '../../src/core/di.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import type { EpochService } from '../../src/modules/auth/services/token/epoch.service.js';
import type { SessionService } from '../../src/modules/auth/services/session/session.service.js';

/// P0-1: a staff role change, removal or password reset takes effect on the very next
/// request — not when the access token happens to expire — and is audited.
describe('staff lifecycle revocation (integration)', () => {
  let app: FastifyInstance;
  let seq = 0;
  const phone = () => `+91977${String(Date.now()).slice(-5)}${String(seq++).padStart(2, '0')}`;

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

  interface Staff {
    userId: string;
    email: string;
    password: string;
    accessToken: string;
    refreshToken: string;
    authHeader: { authorization: string };
  }

  /// A staff member with a real admin-panel session (email + password login).
  async function staff(role: string, password = 'Staff@12345'): Promise<Staff> {
    const seed = await loginAs(app, phone());
    await grantRole(seed.userId, role);
    const email = `staff-${randomUUID().slice(0, 8)}@zaroorat.test`;
    await db().client.user.update({
      where: { id: seed.userId },
      data: { email, passwordHash: hashPassword(password), isEmailVerified: true },
    });
    return { ...(await adminLogin(email, password)), userId: seed.userId, email, password };
  }

  async function adminLogin(email: string, password: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password },
    });
    if (res.statusCode !== 200)
      throw new Error(`admin login failed: ${res.statusCode} ${res.payload}`);
    const body = res.json();
    return {
      accessToken: body.accessToken as string,
      refreshToken: body.refreshToken as string,
      authHeader: { authorization: `Bearer ${body.accessToken}` },
    };
  }

  const get = (url: string, headers: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });

  const updateStaff = (actor: Staff, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${id}`,
      headers: actor.authHeader,
      payload,
    });

  const refresh = (refreshToken: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/token/refresh',
      headers: { 'idempotency-key': randomUUID() },
      payload: { refreshToken },
    });

  /// The audit metadata shape these assertions read (a missing field fails the assertion).
  interface AuditMetadata {
    result: string;
    before: { roles: string[]; status: string; permissionCodes: string[] };
    after: {
      roles: string[];
      status: string;
      changedFields: string[];
      tokensInvalidated: boolean;
      permissionCodes: string[];
      added: string[];
    };
  }
  const meta = (row: { metadata: unknown }) => row.metadata as AuditMetadata;

  const auditRows = (entityId: string) =>
    db().client.adminActivityLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

  // ------------------------------------------------------------ role changes

  it('demoting an admin retires their token at once; refresh yields only the new role', async () => {
    const actor = await staff('system_admin');
    const target = await staff('admin');
    assert.equal((await get('/api/v1/dashboard/financials', target.authHeader)).statusCode, 200);

    const res = await updateStaff(actor, target.userId, { role: 'support' });
    assert.equal(res.statusCode, 200, res.payload);

    const stale = await get('/api/v1/dashboard/overview', target.authHeader);
    assert.equal(stale.statusCode, 401, 'the old admin token must not authorize anything');
    assert.equal(stale.json().error.code, 'TOKEN_STALE');

    const refreshed = await refresh(target.refreshToken);
    assert.equal(refreshed.statusCode, 200, refreshed.payload);
    const fresh = { authorization: `Bearer ${refreshed.json().accessToken}` };
    assert.equal(
      (await get('/api/v1/dashboard/financials', fresh)).statusCode,
      403,
      'admin powers gone',
    );
    assert.equal(
      (await get('/api/v1/dashboard/overview', fresh)).statusCode,
      200,
      'support powers present',
    );
  });

  it('a demoted system_admin loses the bypass on the very next request', async () => {
    const actor = await staff('system_admin');
    const target = await staff('system_admin');
    assert.equal((await get('/api/v1/admin/users', target.authHeader)).statusCode, 200);

    const res = await updateStaff(actor, target.userId, { role: 'admin' });
    assert.equal(res.statusCode, 200, res.payload);

    assert.equal((await get('/api/v1/admin/users', target.authHeader)).statusCode, 401);
    const refreshed = await refresh(target.refreshToken);
    const fresh = { authorization: `Bearer ${refreshed.json().accessToken}` };
    assert.equal(
      (await get('/api/v1/admin/users', fresh)).statusCode,
      403,
      'staff:write is system_admin only; the refreshed token must not carry the bypass',
    );
  });

  it('moving a finance user off finance retires the token; finance endpoints refuse the new one', async () => {
    const actor = await staff('system_admin');
    const target = await staff('finance');
    assert.equal((await get('/api/v1/dashboard/financials', target.authHeader)).statusCode, 200);

    assert.equal((await updateStaff(actor, target.userId, { role: 'support' })).statusCode, 200);
    assert.equal((await get('/api/v1/dashboard/financials', target.authHeader)).statusCode, 401);
    const refreshed = await refresh(target.refreshToken);
    const fresh = { authorization: `Bearer ${refreshed.json().accessToken}` };
    assert.equal((await get('/api/v1/dashboard/financials', fresh)).statusCode, 403);
  });

  it('removing finance:read from the role ends finance access on the next request, same token', async () => {
    const actor = await staff('system_admin');
    const target = await staff('finance');
    assert.equal((await get('/api/v1/dashboard/financials', target.authHeader)).statusCode, 200);

    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/rbac/roles',
      headers: actor.authHeader,
    });
    const financeRole = current.json().data.find((r: { slug: string }) => r.slug === 'finance');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/rbac/roles/finance/permissions',
      headers: actor.authHeader,
      payload: {
        permissionCodes: financeRole.permissionCodes.filter((c: string) => c !== 'finance:read'),
      },
    });
    assert.equal(res.statusCode, 200, res.payload);

    // Permissions are read from the database per request; the token carries none.
    assert.equal((await get('/api/v1/dashboard/financials', target.authHeader)).statusCode, 403);
    assert.equal(
      (await get('/api/v1/auth/me', target.authHeader)).statusCode,
      200,
      'still signed in',
    );
  });

  it('a profile-only edit does not sign the staff member out', async () => {
    const actor = await staff('system_admin');
    const target = await staff('support');
    const res = await updateStaff(actor, target.userId, { firstName: 'Renamed' });
    assert.equal(res.statusCode, 200, res.payload);
    assert.equal((await get('/api/v1/dashboard/overview', target.authHeader)).statusCode, 200);
    const [row] = await auditRows(target.userId);
    assert.equal(meta(row!).after.tokensInvalidated, false);
  });

  // --------------------------------------------------- removal and password reset

  it('removing a staff member ends every session and refresh token', async () => {
    const actor = await staff('system_admin');
    const target = await staff('support');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${target.userId}`,
      headers: actor.authHeader,
    });
    assert.equal(res.statusCode, 204, res.payload);

    assert.equal((await get('/api/v1/dashboard/overview', target.authHeader)).statusCode, 401);
    assert.equal((await refresh(target.refreshToken)).statusCode, 401, 'refresh token revoked');
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: target.email, password: target.password },
    });
    assert.notEqual(relogin.statusCode, 200, 'a removed account cannot sign in again');
    const sessions = await db().client.userSession.count({
      where: { userId: target.userId, revokedAt: null },
    });
    assert.equal(sessions, 0);
  });

  it('an administrator-set password ends existing sessions; only the new password works', async () => {
    const actor = await staff('system_admin');
    const target = await staff('support');

    const res = await updateStaff(actor, target.userId, { password: 'Changed@12345' });
    assert.equal(res.statusCode, 200, res.payload);

    assert.equal((await get('/api/v1/dashboard/overview', target.authHeader)).statusCode, 401);
    assert.equal((await refresh(target.refreshToken)).statusCode, 401);
    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: target.email, password: target.password },
    });
    assert.notEqual(oldPassword.statusCode, 200);
    await adminLogin(target.email, 'Changed@12345');
  });

  // ------------------------------------------------------------------- audit

  it('records every staff and RBAC mutation with actor, roles before and after, and result', async () => {
    const actor = await staff('system_admin');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { ...actor.authHeader, 'user-agent': 'audit-test-agent' },
      payload: {
        firstName: 'Audit',
        lastName: 'Target',
        email: `audit-${randomUUID().slice(0, 8)}@zaroorat.test`,
        phoneNumber: phone(),
        password: 'Audit@12345',
        role: 'support',
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const targetId = created.json().data.id as string;

    assert.equal((await updateStaff(actor, targetId, { role: 'finance' })).statusCode, 200);
    assert.equal(
      (await updateStaff(actor, targetId, { password: 'Secret@98765' })).statusCode,
      200,
    );
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${targetId}`,
      headers: actor.authHeader,
    });
    assert.equal(removed.statusCode, 204);

    const rows = await auditRows(targetId);
    assert.deepEqual(
      rows.map((r) => r.action),
      ['CREATE', 'UPDATE', 'UPDATE', 'DELETE'],
    );
    for (const row of rows) {
      assert.equal(row.actorId, actor.userId);
      assert.equal(row.entityType, 'staff_user');
      assert.equal(meta(row).result, 'SUCCESS');
      assert.ok(row.ipAddress, 'request IP recorded');
    }
    assert.equal(rows[0]!.userAgent, 'audit-test-agent');
    assert.deepEqual(meta(rows[0]!).after.roles, ['support']);
    assert.deepEqual(meta(rows[1]!).before.roles, ['support']);
    assert.deepEqual(meta(rows[1]!).after.roles, ['finance']);
    assert.equal(meta(rows[1]!).after.tokensInvalidated, true);
    assert.ok(meta(rows[2]!).after.changedFields.includes('password'));
    assert.deepEqual(meta(rows[3]!).before.roles, ['finance']);
    assert.equal(meta(rows[3]!).after.status, 'DEACTIVATED');
    const serialized = JSON.stringify(rows);
    for (const secret of ['Audit@12345', 'Secret@98765']) {
      assert.ok(!serialized.includes(secret), 'no password in the audit trail');
    }

    // RBAC: role creation and permission replacement
    const roleName = `Auditors ${randomUUID().slice(0, 6)}`;
    const role = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/rbac/roles',
      headers: actor.authHeader,
      payload: { name: roleName, permissionCodes: ['audit:read'] },
    });
    assert.equal(role.statusCode, 201, role.payload);
    const slug = role.json().data.slug as string;
    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/rbac/roles/${slug}/permissions`,
      headers: actor.authHeader,
      payload: { permissionCodes: ['audit:read', 'riders:read'] },
    });
    assert.equal(replaced.statusCode, 200, replaced.payload);
    const roleRow = await db().client.role.findUniqueOrThrow({ where: { slug } });
    const roleAudit = await auditRows(roleRow.id);
    assert.deepEqual(
      roleAudit.map((r) => r.action),
      ['CREATE', 'UPDATE'],
    );
    assert.ok(roleAudit.every((r) => r.actorId === actor.userId && r.entityType === 'role'));
    assert.deepEqual(meta(roleAudit[1]!).before.permissionCodes, ['audit:read']);
    assert.deepEqual(meta(roleAudit[1]!).after.added, ['riders:read']);
  });

  it('publishes account.role events in the same transaction as the change (durable backstop)', async () => {
    const actor = await staff('system_admin');
    const target = await staff('admin');
    assert.equal((await updateStaff(actor, target.userId, { role: 'support' })).statusCode, 200);
    const events = await db().client.outboxEvent.findMany({
      where: { eventType: { in: ['account.role.revoked', 'account.role.granted'] } },
    });
    type RoleEvent = { data?: { userId?: string; roleSlug?: string } };
    const forChange = events
      .map((e) => ({ type: e.eventType, data: (e.payload as RoleEvent).data }))
      .filter((e) => e.data?.userId === target.userId && e.data?.roleSlug !== 'customer')
      .map((e) => `${e.type}:${e.data?.roleSlug}`)
      .sort();
    assert.deepEqual(forChange, ['account.role.granted:support', 'account.role.revoked:admin']);
  });

  // --------------------------------------------------------------- fail closed

  it('fails closed: if tokens cannot be invalidated, the role change is not applied', async () => {
    const actor = await staff('system_admin');
    const target = await staff('admin');
    const epochService = container.resolve<EpochService>('epochService');
    const original = epochService.bump.bind(epochService);
    epochService.bump = async () => {
      throw new Error('revocation store unavailable');
    };
    let res;
    try {
      res = await updateStaff(actor, target.userId, { role: 'support' });
    } finally {
      epochService.bump = original;
    }
    assert.ok(res.statusCode >= 500, `expected a server error, got ${res.statusCode}`);
    const roles = await db().client.userRoleAssignment.findMany({
      where: { userId: target.userId, revokedAt: null },
      include: { role: true },
    });
    assert.ok(
      roles.some((r) => r.role.slug === 'admin'),
      'the role change rolled back',
    );
    assert.ok(!roles.some((r) => r.role.slug === 'support'));
    assert.deepEqual(
      await auditRows(target.userId),
      [],
      'no audit row for a change that did not happen',
    );
  });

  it('fails closed: if sessions cannot be revoked, the password is not changed', async () => {
    const actor = await staff('system_admin');
    const target = await staff('support');
    const sessionService = container.resolve<SessionService>('sessionService');
    const original = sessionService.revokeAllInTransaction.bind(sessionService);
    sessionService.revokeAllInTransaction = async () => {
      throw new Error('session store unavailable');
    };
    let res;
    try {
      res = await updateStaff(actor, target.userId, { password: 'Never@12345' });
    } finally {
      sessionService.revokeAllInTransaction = original;
    }
    assert.ok(res.statusCode >= 500, `expected a server error, got ${res.statusCode}`);
    await adminLogin(target.email, target.password); // the old password still stands
    const attempt = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: target.email, password: 'Never@12345' },
    });
    assert.notEqual(attempt.statusCode, 200);
  });
});
