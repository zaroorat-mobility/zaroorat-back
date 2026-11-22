import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { db, resetState } from './helpers/harness.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/utils/password.js';
import {
  AdminBootstrapRefusal,
  createFirstAdmin,
  readAdminBootstrapInput,
} from '../../scripts/create-admin.js';

const INPUT = {
  email: 'first-admin@zaroorat.test',
  phone: '+919876541001',
  password: 'correct-horse-battery',
  firstName: 'Platform',
  lastName: 'Admin',
};

async function systemAdminCount(): Promise<number> {
  return db().client.userRoleAssignment.count({
    where: { revokedAt: null, role: { slug: 'system_admin' } },
  });
}

async function existingCustomer(email: string, phoneNumber: string) {
  const passwordHash = hashPassword('customer-own-password');
  return db().client.user.create({
    data: { email, phoneNumber, passwordHash, status: 'SUSPENDED' },
  });
}

describe('first-admin bootstrap: input', () => {
  const env = {
    ADMIN_EMAIL: ' First-Admin@Zaroorat.TEST ',
    ADMIN_PHONE: '+919876541001',
    ADMIN_PASSWORD: '  spaces count too  ',
  };

  it('normalises the email and keeps the password exactly as typed', () => {
    const input = readAdminBootstrapInput(env);
    assert.equal(input.email, 'first-admin@zaroorat.test');
    assert.equal(input.password, '  spaces count too  ');
  });

  for (const missing of ['ADMIN_EMAIL', 'ADMIN_PHONE', 'ADMIN_PASSWORD'] as const) {
    it(`refuses without ${missing} instead of falling back to a default`, () => {
      assert.throws(
        () => readAdminBootstrapInput({ ...env, [missing]: undefined }),
        (err: unknown) => err instanceof AdminBootstrapRefusal && err.message.includes(missing),
      );
    });
  }

  it('refuses a password shorter than 12 characters without echoing it', () => {
    assert.throws(
      () => readAdminBootstrapInput({ ...env, ADMIN_PASSWORD: 'short-pw' }),
      (err: unknown) =>
        err instanceof AdminBootstrapRefusal &&
        /12/.test(err.message) &&
        !err.message.includes('short-pw'),
    );
  });

  it('refuses a phone number that is not E.164', () => {
    assert.throws(
      () => readAdminBootstrapInput({ ...env, ADMIN_PHONE: '9876541001' }),
      AdminBootstrapRefusal,
    );
  });
});

describe('first-admin bootstrap: database (integration)', () => {
  beforeEach(async () => {
    await resetState();
  });

  it('creates one active, verified system_admin with a hashed password and an audit row', async () => {
    const { userId } = await createFirstAdmin(db().client, INPUT, { allowAdditional: false });

    const user = await db().client.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.email, INPUT.email);
    assert.equal(user.phoneNumber, INPUT.phone);
    assert.equal(user.status, 'ACTIVE');
    assert.equal(user.isEmailVerified && user.isPhoneVerified, true);
    assert.notEqual(user.passwordHash, INPUT.password);
    assert.equal(verifyPassword(INPUT.password, user.passwordHash), true);
    assert.equal(await systemAdminCount(), 1);

    const audit = await db().client.adminActivityLog.findMany({ where: { entityId: userId } });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, 'CREATE');
    assert.equal(audit[0]?.actorId, userId);
  });

  it('refuses when a system_admin already exists, and creates nothing', async () => {
    await createFirstAdmin(db().client, INPUT, { allowAdditional: false });
    const second = { ...INPUT, email: 'second@zaroorat.test', phone: '+919876541002' };

    await assert.rejects(
      createFirstAdmin(db().client, second, { allowAdditional: false }),
      (err: unknown) => err instanceof AdminBootstrapRefusal && /already exists/.test(err.message),
    );
    assert.equal(await db().client.user.count({ where: { email: second.email } }), 0);
    assert.equal(await systemAdminCount(), 1);
  });

  it('adds a second system_admin only when asked to explicitly', async () => {
    await createFirstAdmin(db().client, INPUT, { allowAdditional: false });
    const second = { ...INPUT, email: 'second@zaroorat.test', phone: '+919876541002' };

    await createFirstAdmin(db().client, second, { allowAdditional: true });
    assert.equal(await systemAdminCount(), 2);
  });

  for (const clash of ['email', 'phone'] as const) {
    it(`never takes over an existing account that shares the ${clash}`, async () => {
      const customer = await existingCustomer(
        clash === 'email' ? INPUT.email.toUpperCase() : 'customer@zaroorat.test',
        clash === 'phone' ? INPUT.phone : '+919876541099',
      );

      await assert.rejects(
        createFirstAdmin(db().client, INPUT, { allowAdditional: false }),
        (err: unknown) =>
          err instanceof AdminBootstrapRefusal && /existing account/.test(err.message),
      );
      const after = await db().client.user.findUniqueOrThrow({ where: { id: customer.id } });
      assert.equal(after.passwordHash, customer.passwordHash);
      assert.equal(after.status, 'SUSPENDED');
      assert.equal(await systemAdminCount(), 0);
    });
  }

  it('lets exactly one of two simultaneous runs through', async () => {
    const runs = await Promise.allSettled([
      createFirstAdmin(db().client, INPUT, { allowAdditional: false }),
      createFirstAdmin(
        db().client,
        { ...INPUT, email: 'racer@zaroorat.test', phone: '+919876541003' },
        { allowAdditional: false },
      ),
    ]);
    assert.equal(runs.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await systemAdminCount(), 1);
  });

  it('still treats a revoked system_admin as no admin', async () => {
    const { userId } = await createFirstAdmin(db().client, INPUT, { allowAdditional: false });
    await db().client.userRoleAssignment.updateMany({
      where: { userId },
      data: { revokedAt: new Date() },
    });
    const replacement = { ...INPUT, email: 'replacement@zaroorat.test', phone: '+919876541004' };
    await createFirstAdmin(db().client, replacement, { allowAdditional: false });
    assert.equal(await systemAdminCount(), 1);
  });
});
