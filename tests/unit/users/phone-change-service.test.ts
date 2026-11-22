import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PhoneChangeService,
  maskPhone,
} from '../../../src/modules/users/services/phone/phone-change.service.js';
import {
  PhoneInUseError,
  PhoneUnchangedError,
} from '../../../src/modules/users/errors/user.errors.js';
import {
  AccountSuspendedError,
  OtpInvalidError,
  RateLimitedError,
} from '../../../src/modules/auth/errors/auth.errors.js';
import { UniqueConstraintError } from '../../../src/core/database/errors/DatabaseError.js';
import type { PublishInput } from '../../../src/core/events/types.js';
import type { TransactionClient } from '../../../src/core/database/TransactionManager.js';

const TX = { __tx: true } as unknown as TransactionClient;

const USER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_ID = '00000000-0000-7000-8000-000000000002';
const SESSION_ID = '00000000-0000-7000-8000-0000000000a1';
const CHALLENGE_ID = '00000000-0000-7000-8000-0000000000c1';
const OLD_PHONE = '+919876543210';
const NEW_PHONE = '+919876500099';

interface Options {
  holderId?: string | null;
  challenge?: Record<string, unknown> | null;
  allowed?: boolean;
  cached?: unknown;
  status?: string;
  updateConflicts?: boolean;
  activeSessions?: number;
  otpFails?: boolean;
}

function makeService(opts: Options = {}) {
  const seen = {
    order: [] as string[],
    txSeen: {} as Record<string, unknown>,
    published: [] as { input: PublishInput; tx: unknown }[],
    metrics: [] as string[],
    sent: [] as unknown[],
    verified: [] as unknown[],
    idempotencyPuts: [] as unknown[],
    createdSession: undefined as unknown,
  };

  const record = (step: string, tx?: unknown) => {
    seen.order.push(step);
    if (tx !== undefined) seen.txSeen[step] = tx;
  };

  const holder =
    opts.holderId === undefined || opts.holderId === null ? null : { id: opts.holderId };

  const userRepository = {
    findById: async () => ({
      id: USER_ID,
      phoneNumber: OLD_PHONE,
      status: opts.status ?? 'ACTIVE',
      deletedAt: null,
    }),
    findActiveByPhone: async (_phone: string, tx?: TransactionClient) => {
      record('recheck', tx);
      return holder;
    },
    updatePhoneNumber: async (_id: string, phoneNumber: string, tx?: TransactionClient) => {
      record('update', tx);
      if (opts.updateConflicts) throw new UniqueConstraintError('phone_number');
      return { id: USER_ID, phoneNumber };
    },
  };

  const otpService = {
    send: async (input: unknown) => {
      seen.sent.push(input);
      record('otp:send');
      return { challengeId: CHALLENGE_ID, expiresInSec: 300, resendAvailableInSec: 60 };
    },
    verify: async (input: unknown) => {
      record('otp:verify');
      if (opts.otpFails) throw new OtpInvalidError();
      seen.verified.push(input);
    },
  };

  const otpRepository = {
    findById: async () =>
      opts.challenge === null
        ? null
        : {
            id: CHALLENGE_ID,
            phoneNumber: NEW_PHONE,
            purpose: 'PHONE_CHANGE',
            userId: USER_ID,
            verifiedAt: null,
            ...opts.challenge,
          },
  };

  const roleRepository = { findActiveRoleSlugs: async () => ['customer'] };

  const sessionService = {
    revokeAllInTransaction: async (_userId: string, _reason: string, tx: TransactionClient) => {
      record('revoke', tx);
      return opts.activeSessions ?? 3;
    },
    create: async (input: unknown) => {
      record('session:create');
      seen.createdSession = input;
      return { id: 'new-session', expiresAt: new Date() };
    },
  };

  const sessionRepository = {
    findById: async () => ({ id: SESSION_ID, userId: USER_ID, deviceId: 'device-1' }),
  };

  const tokenService = {
    issuePair: async () => {
      record('issue');
      return {
        accessToken: 'access',
        accessTokenExpiresInSec: 900,
        refreshToken: 'refresh',
        refreshTokenExpiresInSec: 2_592_000,
      };
    },
  };

  const epochService = {
    bump: async () => {
      record('epoch:bump');
      return 2;
    },
  };

  const redisService = {
    rateLimit: {
      hit: async () => ({
        allowed: opts.allowed ?? true,
        current: 1,
        remaining: 2,
        retryAfterSeconds: 3600,
      }),
    },

    idempotency: {
      get: async () => opts.cached ?? null,
      put: async (_operation: string, _key: string, value: unknown) => {
        seen.idempotencyPuts.push(value);
      },
      runOnce: async <T>(
        _operation: string,
        _key: string,
        _ttl: number,
        action: () => Promise<T>,
      ): Promise<T> => {
        if (opts.cached) return opts.cached as T;
        const result = await action();
        seen.idempotencyPuts.push(result);
        return result;
      },
    },
  };

  const eventPublisher = {
    publish: async (input: PublishInput, tx?: TransactionClient) => {
      seen.published.push({ input, tx });
      record(`publish:${input.type}`, tx);
    },
  };

  const transactionManager = {
    execute: async <T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> => {
      record('tx:begin');
      const out = await cb(TX);
      record('tx:commit');
      return out;
    },
  };

  const userMetrics = {
    phoneChangeRequested: () => seen.metrics.push('request'),
    phoneChangeSucceeded: () => seen.metrics.push('success'),
    phoneChangeFailed: () => seen.metrics.push('failed'),
    phoneRateLimited: () => seen.metrics.push('rate_limited'),
  };

  const service = new PhoneChangeService(
    userRepository as never,
    otpService as never,
    otpRepository as never,
    roleRepository as never,
    sessionService as never,
    sessionRepository as never,
    tokenService as never,
    epochService as never,
    redisService as never,
    eventPublisher as never,
    transactionManager as never,
    userMetrics as never,
    { refreshTtlSeconds: 2_592_000 } as never,
  );
  return { service, seen };
}

function verify(service: PhoneChangeService, key = 'idem-key-1') {
  return service.verifyPhoneChange(
    { userId: USER_ID, sessionId: SESSION_ID, challengeId: CHALLENGE_ID, code: '482913' },
    key,
  );
}

describe('maskPhone', () => {
  it('produces the form doc 05 §5 specifies', () => {
    assert.equal(maskPhone('+919876500099'), '+9198765•••99');
  });

  it('never returns the whole number, however short it is', () => {
    for (const number of ['+12345678', '+441632960099', '+919876500099']) {
      assert.ok(!maskPhone(number).includes(number.slice(1)), number);
      assert.ok(maskPhone(number).includes('•••'), number);
      assert.ok(maskPhone(number).length <= number.length, number);
    }
  });
});

describe('PhoneChangeService — request (unit)', () => {
  it('sends the OTP to the NEW number, with the phone-change purpose', async () => {
    const { service, seen } = makeService();
    const challenge = await service.requestPhoneChange({
      userId: USER_ID,
      newPhoneNumber: NEW_PHONE,
    });

    assert.deepEqual(challenge, {
      challengeId: CHALLENGE_ID,
      expiresInSec: 300,
      resendAvailableInSec: 60,
    });

    assert.deepEqual(seen.sent, [
      { phoneNumber: NEW_PHONE, purpose: 'PHONE_CHANGE', userId: USER_ID },
    ]);
  });

  it('announces the request with a masked number and no plaintext one', async () => {
    const { service, seen } = makeService();
    await service.requestPhoneChange({ userId: USER_ID, newPhoneNumber: NEW_PHONE });

    const event = seen.published.find((p) => p.input.type === 'user.phone.change_requested')!;
    assert.equal(event.input.classification, 'observability', 'doc 05 §3.2');
    assert.equal(event.input.producer, 'users');
    assert.deepEqual(event.input.data, {
      userId: USER_ID,
      challengeId: CHALLENGE_ID,
      newPhoneMasked: '+9198765•••99',
    });
    assert.ok(
      !JSON.stringify(event.input).includes(NEW_PHONE),
      'no unmasked number in the payload',
    );
  });

  it('trips the per-account cap before any lookup or send (R-USER-15)', async () => {
    const { service, seen } = makeService({ allowed: false });
    await assert.rejects(
      service.requestPhoneChange({ userId: USER_ID, newPhoneNumber: NEW_PHONE }),
      (err: unknown) => err instanceof RateLimitedError && err.retryAfterSeconds === 3600,
    );

    assert.deepEqual(seen.order, [], 'nothing was looked up and no code was sent');
    assert.deepEqual(seen.metrics, ['rate_limited']);
  });

  it('refuses the number the account already holds', async () => {
    const { service, seen } = makeService();
    await assert.rejects(
      service.requestPhoneChange({ userId: USER_ID, newPhoneNumber: OLD_PHONE }),
      PhoneUnchangedError,
    );
    assert.equal(seen.sent.length, 0, 'no code is spent proving nothing');
  });

  it('refuses a number another active account holds', async () => {
    const { service, seen } = makeService({ holderId: OTHER_ID });
    await assert.rejects(
      service.requestPhoneChange({ userId: USER_ID, newPhoneNumber: NEW_PHONE }),
      PhoneInUseError,
    );
    assert.equal(seen.sent.length, 0, 'no SMS to a number the caller cannot have');
  });

  it('is a no-op refusal for a non-active account (R-USER-9)', async () => {
    const { service } = makeService({ status: 'SUSPENDED' });
    await assert.rejects(
      service.requestPhoneChange({ userId: USER_ID, newPhoneNumber: NEW_PHONE }),
      AccountSuspendedError,
    );
  });
});

describe('PhoneChangeService — verify (unit)', () => {
  it('commits the number, the revocation, and both events as one transaction', async () => {
    const { service, seen } = makeService();
    await verify(service);

    for (const step of [
      'recheck',
      'update',
      'revoke',
      'publish:user.phone.changed',
      'publish:account.recovery.completed',
    ]) {
      assert.equal(seen.txSeen[step], TX, `${step} joins the change transaction`);
    }
    assert.deepEqual(
      seen.order.slice(seen.order.indexOf('tx:begin')),
      [
        'tx:begin',
        'recheck',
        'update',
        'revoke',
        'publish:user.phone.changed',
        'publish:account.recovery.completed',
        'tx:commit',
        'epoch:bump',
        'session:create',
        'issue',
      ],
      'nothing non-transactional runs before the commit (R-USER-30)',
    );
  });

  it('signs the replacement pair after the epoch bump, not before', async () => {
    const { service, seen } = makeService();
    await verify(service);

    assert.ok(
      seen.order.indexOf('epoch:bump') < seen.order.indexOf('issue'),
      'the new token carries the new epoch',
    );
  });

  it('re-binds the replacement session to the calling device only', async () => {
    const { service, seen } = makeService();
    const result = await verify(service);

    assert.deepEqual(seen.createdSession, {
      userId: USER_ID,
      loginMethod: 'phone_change',
      deviceId: 'device-1',
      expiresAt: (seen.createdSession as { expiresAt: Date }).expiresAt,
    });
    assert.equal(result.user.id, USER_ID, 'the identity is preserved (USER-INV-3)');
    assert.equal(result.user.phoneNumber, NEW_PHONE);
    assert.equal(result.accessToken, 'access');
  });

  it('carries masked numbers and a count into the audit payload', async () => {
    const { service, seen } = makeService({ activeSessions: 3 });
    await verify(service);

    const changed = seen.published.find((p) => p.input.type === 'user.phone.changed')!.input;
    assert.equal(changed.classification, 'audit');
    assert.equal(changed.producer, 'users');
    assert.deepEqual(changed.data, {
      userId: USER_ID,
      oldPhoneMasked: '+9198765•••10',
      newPhoneMasked: '+9198765•••99',
      sessionsRevoked: 3,
    });

    const recovery = seen.published.find(
      (p) => p.input.type === 'account.recovery.completed',
    )!.input;
    assert.deepEqual(recovery.data, { userId: USER_ID, actor: 'self', changedPhone: true });

    const payloads = JSON.stringify(seen.published.map((p) => p.input));
    assert.ok(!payloads.includes(OLD_PHONE), 'no unmasked old number anywhere');
    assert.ok(!payloads.includes(NEW_PHONE), 'no unmasked new number anywhere');
  });

  it('reads the target from the challenge, never from the caller', async () => {
    const { service, seen } = makeService();
    await verify(service);

    assert.deepEqual(seen.verified, [
      {
        phoneNumber: NEW_PHONE,
        purpose: 'PHONE_CHANGE',
        code: '482913',
        challengeId: CHALLENGE_ID,
      },
    ]);
  });

  it("refuses another user's challenge, and one minted for another purpose", async () => {
    for (const challenge of [
      { userId: OTHER_ID },
      { purpose: 'LOGIN' },
      { verifiedAt: new Date() },
      null,
    ]) {
      const { service, seen } = makeService({ challenge });
      await assert.rejects(verify(service), OtpInvalidError, JSON.stringify(challenge));

      assert.equal(seen.verified.length, 0, 'no code was consumed');
      assert.equal(seen.order.includes('update'), false, 'nothing was written');
    }
  });

  it('answers a lost uniqueness race with PHONE_IN_USE, not a 500', async () => {
    const { service, seen } = makeService({ updateConflicts: true });
    await assert.rejects(verify(service), PhoneInUseError);
    assert.deepEqual(seen.metrics, ['failed']);
    assert.equal(seen.order.includes('epoch:bump'), false, 'no side effects after a rollback');
  });

  it('refuses the change when the re-check finds a new holder', async () => {
    const { service, seen } = makeService({ holderId: OTHER_ID });
    await assert.rejects(verify(service), PhoneInUseError);
    assert.equal(seen.order.includes('update'), false);
  });

  it('replays a retried key without consuming a code or revoking again', async () => {
    const cached = { accessToken: 'stored', user: { id: USER_ID } };
    const { service, seen } = makeService({ cached });

    assert.deepEqual(await verify(service), cached as never);
    assert.deepEqual(seen.order, [], 'the whole flow was skipped');
    assert.equal(seen.verified.length, 0, 'the OTP was not consumed a second time');
  });

  it('stores the response for replay only after it is real', async () => {
    const { service, seen } = makeService();
    const result = await verify(service);
    assert.deepEqual(seen.idempotencyPuts, [result]);
    assert.deepEqual(seen.metrics, ['success']);
  });

  it('leaves the account untouched when the code is wrong', async () => {
    const { service, seen } = makeService({ otpFails: true });

    await assert.rejects(verify(service), OtpInvalidError);
    assert.deepEqual(seen.metrics, ['failed']);
    assert.deepEqual(seen.order, ['otp:verify'], 'no transaction, no revocation, no bump');
  });
});
