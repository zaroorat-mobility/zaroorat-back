import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthService } from '../../../src/modules/auth/auth.service.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

/** The sentinel the fake TransactionManager hands to the login callback. */
const TX = { __tx: true } as unknown as TransactionClient;

const USER_ID = '00000000-0000-7000-8000-000000000001';
const PHONE = '+919876543210';

/**
 * Wire an AuthService whose collaborators record the transaction they were
 * handed, so a test can prove the profile insert and `user.profile.created`
 * join the *login* transaction rather than running beside it (R-USER-27).
 *
 * @param opts `existingUser` returns a returning caller; `profileCreated` is
 *             what `ensureExists` reports.
 */
function makeService(opts: { existingUser?: boolean; profileCreated?: boolean } = {}) {
  const seen = {
    ensureTx: undefined as unknown,
    ensureUserId: undefined as unknown,
    published: [] as { input: PublishInput; tx: unknown }[],
    order: [] as string[],
  };

  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => cb(TX),
  };
  const otpService = { verify: async () => undefined };
  const user = { id: USER_ID, status: 'ACTIVE', phoneNumber: PHONE, isPhoneVerified: true };
  const userRepository = {
    findActiveByPhone: async () => (opts.existingUser ? user : null),
    create: async () => {
      seen.order.push('user');
      return user;
    },
    updateLastLoginAt: async () => user,
  };
  const userProfileRepository = {
    ensureExists: async (userId: string, tx: TransactionClient) => {
      seen.ensureUserId = userId;
      seen.ensureTx = tx;
      seen.order.push('profile');
      return opts.profileCreated ?? true;
    },
  };
  const roleRepository = {
    findBySlug: async () => ({ id: 'role-1', slug: 'customer' }),
    findActiveAssignment: async () => (opts.existingUser ? { id: 'a1' } : null),
    grant: async () => {
      seen.order.push('role');
      return { id: 'a1' };
    },
    findActiveRoleSlugs: async () => ['customer'],
  };
  const deviceService = {
    register: async () => {
      seen.order.push('device');
      return { id: 'dev-1' };
    },
  };
  const sessionService = {
    createInTransaction: async () => {
      seen.order.push('session');
      return { id: 'sess-1', expiresAt: new Date('2026-08-30T00:00:00.000Z') };
    },
    enforceCap: async () => undefined,
  };
  const tokenService = {
    issuePair: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 }),
  };
  const redisService = { idempotency: { get: async () => null, put: async () => undefined } };
  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.published.push({ input, tx });
      seen.order.push(`publish:${input.type}`);
    },
  };

  const service = new AuthService(
    otpService as never,
    userRepository as never,
    userProfileRepository as never,
    roleRepository as never,
    deviceService as never,
    sessionService as never,
    tokenService as never,
    redisService as never,
    eventPublisher as never,
    transactionManager as never,
    { refreshTtlSeconds: 2_592_000 } as never,
    { maxConcurrentSessions: 5, privilegedMaxConcurrentSessions: 2 } as never,
  );
  return { service, seen };
}

/** The `user.profile.created` envelopes published during a login. */
function profileEvents(seen: { published: { input: PublishInput; tx: unknown }[] }) {
  return seen.published.filter((p) => p.input.type === 'user.profile.created');
}

// Registration provisions the profile inside AUTH's login unit of work
// (user doc 03 §4.1, FLOW §1). These assertions are the unit-level half of
// USER-INV-1; the rollback half needs a real database and lives in
// tests/integration/user-registration.test.ts.
describe('AuthService — profile provisioning (unit)', () => {
  it('creates the profile inside the login transaction, before the session exists', async () => {
    const { service, seen } = makeService();
    await service.verifyOtp({ phoneNumber: PHONE, code: '123456' });

    assert.equal(seen.ensureUserId, USER_ID);
    assert.equal(seen.ensureTx, TX, 'the profile insert joins the login transaction');
    assert.deepEqual(
      seen.order.slice(0, 4),
      ['user', 'role', 'profile', 'publish:user.profile.created'],
      'the profile follows the account it belongs to and precedes the session',
    );
  });

  it('emits user.profile.created on the same transaction, carrying only the id', async () => {
    const { service, seen } = makeService();
    await service.verifyOtp({ phoneNumber: PHONE, code: '123456' });

    const events = profileEvents(seen);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.tx, TX, 'the event commits with the row it announces');

    const event = events[0]!.input;
    assert.equal(event.producer, 'users', 'USER owns this event, not AUTH (doc 05 §2)');
    assert.equal(event.classification, 'domain');
    assert.equal(event.subjectUserId, USER_ID);
    assert.deepEqual(event.data, { userId: USER_ID }, 'the payload is the id and nothing else');
    assert.ok(!JSON.stringify(event).includes(PHONE), 'no phone number in the event');
  });

  it('stays quiet on a returning login, when the profile already exists', async () => {
    const { service, seen } = makeService({ existingUser: true, profileCreated: false });
    await service.verifyOtp({ phoneNumber: PHONE, code: '123456' });

    assert.equal(seen.ensureTx, TX, 'the check still runs — it is what makes it self-healing');
    assert.equal(profileEvents(seen).length, 0, 'nothing was created, so nothing is announced');
  });

  it('heals an account that predates this wiring, on its next login', async () => {
    const { service, seen } = makeService({ existingUser: true, profileCreated: true });
    await service.verifyOtp({ phoneNumber: PHONE, code: '123456' });

    // A returning user with no profile row gets one, and it is announced — the
    // referral module still learns the profile is ready (doc 05 §3.1).
    assert.equal(profileEvents(seen).length, 1);
    assert.equal(
      seen.published.some((p) => p.input.type === 'account.role.granted'),
      false,
      'a returning account is not re-announced as new',
    );
  });
});
