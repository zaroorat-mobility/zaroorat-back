import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AuthService } from '../../../src/modules/auth/services/auth.service.js';
import {
  AccountDeactivatedError,
  AccountSuspendedError,
  AuthError,
} from '../../../src/modules/auth/errors/auth.errors.js';
import { AUTH_ERROR_STATUS } from '../../../src/modules/auth/schemas/error-response.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;
const USER_ID = '00000000-0000-7000-8000-000000000001';
const PHONE = '+919876543210';

interface Options {
  user?: { id: string; status: string; isPhoneVerified: boolean; deletedAt: Date | null } | null;
}

function makeService(opts: Options = {}) {
  const seen = {
    order: [] as string[],
    published: [] as PublishInput[],
    idempotencyPuts: 0,
  };

  const row =
    opts.user === undefined
      ? { id: USER_ID, status: 'ACTIVE', isPhoneVerified: true, deletedAt: null }
      : opts.user;

  const otpService = {
    verify: async () => {
      seen.order.push('otp:verified');
    },
  };
  const userRepository = {
    findActiveByPhone: async () => row,
    create: async () => {
      seen.order.push('user:created');
      return { id: USER_ID, status: 'ACTIVE', isPhoneVerified: true, deletedAt: null };
    },
    updateStatus: async (_id: string, status: string) => {
      seen.order.push(`user:status=${status}`);
      return { ...row, status };
    },
    markPhoneVerified: async () => {
      seen.order.push('user:phoneVerified');
    },
    updateLastLoginAt: async () => {
      seen.order.push('user:lastLogin');
    },
    findById: async () => row,
  };
  const userProfileRepository = {
    ensureExists: async () => {
      seen.order.push('profile');
      return false;
    },
  };
  const roleRepository = {
    findBySlug: async () => ({ id: 'role-1', slug: 'customer' }),
    findActiveAssignment: async () => ({ id: 'a1' }),
    grant: async () => ({ id: 'a1' }),
    findActiveRoleSlugs: async () => ['customer'],
  };
  const deviceService = {
    register: async () => {
      seen.order.push('device:registered');
      return { id: 'dev-1' };
    },
  };
  const sessionService = {
    createInTransaction: async () => {
      seen.order.push('session:created');
      return { id: 'sess-1', expiresAt: new Date('2026-09-30T00:00:00.000Z') };
    },
    enforceCap: async () => undefined,
  };
  const tokenService = {
    issuePair: async () => {
      seen.order.push('tokens:issued');

      return {
        accessToken: 'ACCESS.TOKEN.FIXTURE',
        accessTokenExpiresInSec: 900,
        refreshToken: 'REFRESH-TOKEN-FIXTURE',
        refreshTokenExpiresInSec: 2_592_000,
      };
    },
  };
  const redisService = {
    idempotency: {
      get: async () => null,
      put: async () => {
        seen.idempotencyPuts += 1;
      },
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
    { bump: async () => 2, current: async () => 1 } as never,
    redisService as never,
    {
      publish: async (input: PublishInput) => {
        seen.published.push(input);
      },
    } as never,
    {
      execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => cb(TX),
    } as never,
    { refreshTtlSeconds: 2_592_000 } as never,
    { maxConcurrentSessions: 5, privilegedMaxConcurrentSessions: 2 } as never,
  );
  return { service, seen };
}

const login = () => ({ phoneNumber: PHONE, code: '123456' });

describe('AuthService.verifyOtp — account state gate', () => {
  it('lets an ACTIVE account through, unchanged', async () => {
    const { service, seen } = makeService();
    const result = await service.verifyOtp(login());

    assert.equal(result.user.id, USER_ID);
    assert.equal(result.user.status, 'ACTIVE');
    assert.ok(result.accessToken && result.refreshToken, 'both tokens are issued');
    assert.ok(seen.order.includes('session:created'));
    assert.ok(seen.order.includes('tokens:issued'));
  });

  it('registers an unknown number as a new ACTIVE account', async () => {
    const { service, seen } = makeService({ user: null });
    const result = await service.verifyOtp(login());

    assert.equal(result.user.isNew, true);
    assert.ok(seen.order.includes('user:created'));
    assert.ok(seen.order.includes('tokens:issued'));
  });

  it('promotes a verified-but-UNVERIFIED account rather than refusing it', async () => {
    const { service, seen } = makeService({
      user: { id: USER_ID, status: 'UNVERIFIED', isPhoneVerified: false, deletedAt: null },
    });
    const result = await service.verifyOtp(login());

    assert.ok(seen.order.includes('user:status=ACTIVE'));
    assert.ok(result.accessToken, 'and it does get a token');
  });

  const refusals: [string, Options, new (...args: never[]) => Error, string][] = [
    [
      'DEACTIVATED',
      { user: { id: USER_ID, status: 'DEACTIVATED', isPhoneVerified: true, deletedAt: null } },
      AccountDeactivatedError,
      'ACCOUNT_DEACTIVATED',
    ],
    [
      'SUSPENDED',
      { user: { id: USER_ID, status: 'SUSPENDED', isPhoneVerified: true, deletedAt: null } },
      AccountSuspendedError,
      'ACCOUNT_SUSPENDED',
    ],
    [
      'soft-deleted / erased',
      { user: { id: USER_ID, status: 'ACTIVE', isPhoneVerified: true, deletedAt: new Date() } },
      AccountSuspendedError,
      'ACCOUNT_SUSPENDED',
    ],
  ];

  for (const [label, opts, expected, code] of refusals) {
    describe(`a ${label} account`, () => {
      it('is refused with a 403', async () => {
        const { service } = makeService(opts);
        await assert.rejects(service.verifyOtp(login()), (err: unknown) => {
          assert.ok(err instanceof expected, `expected ${expected.name}`);
          assert.ok(err instanceof AuthError);
          assert.equal(err.code, code);
          assert.equal(AUTH_ERROR_STATUS[code], 403);
          return true;
        });
      });

      it('gets no session and no tokens', async () => {
        const { service, seen } = makeService(opts);
        await assert.rejects(service.verifyOtp(login()));

        assert.ok(!seen.order.includes('session:created'), 'no session was opened');
        assert.ok(!seen.order.includes('tokens:issued'), 'no token pair was minted');
        assert.ok(!seen.order.includes('user:lastLogin'), 'and it was not recorded as a login');
      });

      it('is not silently reactivated', async () => {
        const { service, seen } = makeService(opts);
        await assert.rejects(service.verifyOtp(login()));

        assert.ok(
          !seen.order.some((step) => step === 'user:status=ACTIVE'),
          'the status was left exactly as the user set it',
        );
      });

      it('announces no login and caches no idempotent success', async () => {
        const { service, seen } = makeService(opts);
        await assert.rejects(service.verifyOtp(login(), 'idem-key-1'));

        assert.equal(seen.idempotencyPuts, 0, 'a refusal must not be replayable as a success');
        for (const type of ['auth.login.succeeded', 'auth.session.created', 'auth.otp.verified']) {
          assert.ok(
            !seen.published.some((event) => event.type === type),
            `${type} must not be emitted for a refused login`,
          );
        }
      });
    });
  }

  describe('durable event payloads', () => {
    it('never carries the plaintext phone number', async () => {
      const { service, seen } = makeService();
      await service.verifyOtp(login());

      for (const event of seen.published) {
        assert.ok(
          !JSON.stringify(event).includes(PHONE),
          `${event.type} must not carry the phone number`,
        );
      }
    });

    it('still identifies the subject of auth.otp.verified', async () => {
      const { service, seen } = makeService();
      await service.verifyOtp(login());

      const verified = seen.published.find((e) => e.type === 'auth.otp.verified');
      assert.ok(verified, 'the event is still emitted');
      assert.deepEqual(verified.data, {
        userId: USER_ID,
        purpose: 'LOGIN',
        isNewAccount: false,
      });
      assert.equal(verified.subjectUserId, USER_ID);
    });

    it('keeps tokens out of the durable payloads too', async () => {
      const { service, seen } = makeService();
      const result = await service.verifyOtp(login());

      const serialized = JSON.stringify(seen.published);
      assert.ok(!serialized.includes(result.accessToken));
      assert.ok(!serialized.includes(result.refreshToken));
    });
  });

  it('distinguishes deactivated from suspended, because the remedy differs', async () => {
    const [deactivated, suspended] = await Promise.all(
      refusals.slice(0, 2).map(async ([, opts]) => {
        const { service } = makeService(opts);
        return service.verifyOtp(login()).catch((err: unknown) => (err as { code: string }).code);
      }),
    );
    assert.notEqual(deactivated, suspended);
  });
});
