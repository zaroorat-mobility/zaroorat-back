import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import type { AuthService } from '../../src/modules/auth/services/auth.service.js';

const PHONE = '+919876519001';

describe('role grant and revocation (integration)', () => {
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

  function auth(): AuthService {
    return container.resolve<AuthService>('authService');
  }

  function probe(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  async function events(eventType: string, roleSlug?: string) {
    const rows = await db().client.outboxEvent.findMany({
      where: { eventType },
      orderBy: { createdAt: 'asc' },
    });
    const payloads = rows.map((row) => row.payload as unknown as { data: Record<string, unknown> });
    return roleSlug ? payloads.filter((p) => p.data.roleSlug === roleSlug) : payloads;
  }

  function activeAssignments(userId: string) {
    return db().client.userRoleAssignment.findMany({ where: { userId, revokedAt: null } });
  }

  describe('granting', () => {
    it('adds the role, audits it, and invalidates the stale roles claim', async () => {
      const user = await loginAs(app, PHONE);
      assert.deepEqual((await probe(user.accessToken)).json().roles, ['customer']);

      assert.equal(await auth().grantRole(user.userId, 'driver'), true);

      const stale = await probe(user.accessToken);
      assert.equal(stale.statusCode, 401);
      assert.equal(stale.json().error.code, 'TOKEN_STALE');

      const [granted] = await events('account.role.granted', 'driver');
      assert.deepEqual(granted?.data, { userId: user.userId, roleSlug: 'driver' });
    });

    it('hands the new role to the next login, in the claim and in GET /me', async () => {
      const user = await loginAs(app, PHONE);
      await auth().grantRole(user.userId, 'driver');

      const returned = await loginAs(app, PHONE);
      const me = await probe(returned.accessToken);
      assert.equal(me.statusCode, 200, me.payload);
      assert.deepEqual([...me.json().roles].sort(), ['customer', 'driver']);
    });

    it('is idempotent — a role already held is not re-granted or re-announced', async () => {
      const user = await loginAs(app, PHONE);

      assert.equal(await auth().grantRole(user.userId, 'customer'), false);
      assert.equal((await activeAssignments(user.userId)).length, 1);
      assert.equal(
        (await events('account.role.granted', 'customer')).length,
        1,
        'only registration announced it',
      );
    });

    it('does not sign anyone out for a grant that changed nothing', async () => {
      const user = await loginAs(app, PHONE);
      await auth().grantRole(user.userId, 'customer');

      assert.equal((await probe(user.accessToken)).statusCode, 200);
    });

    it('carries the actor and expiry when a scoped grant supplies them', async () => {
      const user = await loginAs(app, PHONE);
      const operator = await loginAs(app, '+919876519002');
      const expiresAt = new Date(Date.now() + 86_400_000);

      await auth().grantRole(user.userId, 'support', {
        grantedBy: operator.userId,
        expiresAt,
      });

      const [granted] = await events('account.role.granted', 'support');
      assert.deepEqual(granted?.data, {
        userId: user.userId,
        roleSlug: 'support',
        grantedBy: operator.userId,
        expiresAt: expiresAt.toISOString(),
      });
      const row = await db().client.userRoleAssignment.findFirstOrThrow({
        where: { userId: user.userId, revokedAt: null, grantedBy: operator.userId },
      });
      assert.equal(row.expiresAt?.toISOString(), expiresAt.toISOString());
    });

    it('refuses a slug that is not seeded', async () => {
      const user = await loginAs(app, PHONE);

      await assert.rejects(auth().grantRole(user.userId, 'wizard'), /not seeded/);
    });
  });

  describe('revoking', () => {
    it('revokes by timestamp, audits it, and retires the stale claim', async () => {
      const user = await loginAs(app, PHONE);
      await auth().grantRole(user.userId, 'driver');
      const returned = await loginAs(app, PHONE);

      assert.equal(await auth().revokeRole(user.userId, 'driver'), true);

      const stale = await probe(returned.accessToken);
      assert.equal(stale.json().error.code, 'TOKEN_STALE');

      const [revoked] = await events('account.role.revoked');
      assert.deepEqual(revoked?.data, { userId: user.userId, roleSlug: 'driver' });

      const rows = await db().client.userRoleAssignment.findMany({
        where: { userId: user.userId },
      });
      assert.equal(rows.length, 2, 'both assignments still exist');
      assert.equal(rows.filter((r) => r.revokedAt !== null).length, 1);
    });

    it('drops the role from the next login', async () => {
      const user = await loginAs(app, PHONE);
      await auth().grantRole(user.userId, 'driver');
      await auth().revokeRole(user.userId, 'driver');

      const returned = await loginAs(app, PHONE);
      assert.deepEqual((await probe(returned.accessToken)).json().roles, ['customer']);
    });

    it('is a no-op when the role is not held', async () => {
      const user = await loginAs(app, PHONE);
      assert.equal(await auth().revokeRole(user.userId, 'driver'), false);
      assert.equal((await events('account.role.revoked')).length, 0);
      assert.equal((await probe(user.accessToken)).statusCode, 200, 'and nobody was signed out');
    });

    it('carries the actor and reason when supplied', async () => {
      const user = await loginAs(app, PHONE);
      const operator = await loginAs(app, '+919876519002');
      await auth().grantRole(user.userId, 'driver');
      await auth().revokeRole(user.userId, 'driver', {
        revokedBy: operator.userId,
        reason: 'onboarding_failed',
      });

      const [revoked] = await events('account.role.revoked');
      assert.deepEqual(revoked?.data, {
        userId: user.userId,
        roleSlug: 'driver',
        revokedBy: operator.userId,
        reason: 'onboarding_failed',
      });
    });
  });

  describe('uq_user_role_active', () => {
    it('allows a re-grant once the previous assignment is revoked', async () => {
      const user = await loginAs(app, PHONE);
      await auth().grantRole(user.userId, 'driver');
      await auth().revokeRole(user.userId, 'driver');

      assert.equal(await auth().grantRole(user.userId, 'driver'), true, 'the role can come back');

      const rows = await db().client.userRoleAssignment.findMany({
        where: { userId: user.userId, role: { slug: 'driver' } },
      });
      assert.equal(rows.length, 2, 'a new row, not a revived one');
      assert.equal(rows.filter((r) => r.revokedAt === null).length, 1, 'exactly one live');
    });

    it('rejects a second live assignment of the same role at the database', async () => {
      const user = await loginAs(app, PHONE);
      const role = await db().client.role.findUniqueOrThrow({ where: { slug: 'driver' } });
      await auth().grantRole(user.userId, 'driver');

      await assert.rejects(
        db().client.userRoleAssignment.create({ data: { userId: user.userId, roleId: role.id } }),
        /Unique constraint|uq_user_role_active/i,
      );
      assert.equal((await activeAssignments(user.userId)).length, 2, 'customer + driver, no more');
    });

    it('admits exactly one of several concurrent grants of the same role', async () => {
      const user = await loginAs(app, PHONE);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 4 }, () => auth().grantRole(user.userId, 'driver')),
      );

      const applied = outcomes.filter((o) => o.status === 'fulfilled' && o.value === true);
      assert.equal(applied.length, 1, 'one caller granted it');
      const live = await db().client.userRoleAssignment.count({
        where: { userId: user.userId, role: { slug: 'driver' }, revokedAt: null },
      });
      assert.equal(live, 1, 'and the database holds exactly one live assignment');
    });
  });

  it('reflects a grant made after the token was minted, before the token catches up', async () => {
    const user = await loginAs(app, PHONE);
    await auth().grantRole(user.userId, 'driver');

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token/refresh',
      headers: { 'idempotency-key': randomUUID() },
      payload: { refreshToken: user.refreshToken },
    });
    assert.equal(refreshed.statusCode, 200, refreshed.payload);

    const me = await probe(refreshed.json().accessToken);
    assert.equal(me.statusCode, 200, me.payload);
    assert.deepEqual([...me.json().roles].sort(), ['customer', 'driver']);
    void FIXED_OTP;
  });
});
