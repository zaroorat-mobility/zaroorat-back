import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { FIXED_OTP, bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { redis } from '../../src/core/cache/client.js';
import { RedisKeys } from '../../src/core/cache/keys.js';
import type { OtpHasher } from '../../src/modules/auth/otp/otp.hasher.js';
import type { UserRepository } from '../../src/modules/auth/repositories/user.repository.js';

/** Registered before each relevant test. */
const KNOWN = '+919876527001';
/** Never registered, and never sent to except by the test that needs it. */
const UNKNOWN = '+919876527002';

/**
 * Enumeration resistance (R-AUTH-19, doc 02 §4.4, doc 07 §5).
 *
 * Doc 02 §4.4 makes three claims. Two are about responses and are decided
 * byte-for-byte. The third — "timing is kept uniform (do the same hash/compare
 * work on the miss path)" — names a **mechanism**, and that is what these tests
 * assert.
 *
 * **There is deliberately no wall-clock assertion here.** A tolerance tight
 * enough to catch a real oracle is looser than the noise of a shared Postgres and
 * Redis container plus GC, so it would fail on a busy runner and get deleted the
 * first week. Counting the work instead is deterministic and strictly stronger:
 * it fails on the *cause* (an extra lookup on one path) rather than on a
 * downstream symptom that a fast machine can hide. A wall-clock check belongs in
 * a dedicated benchmark, not in a suite that gates merges.
 */
describe('enumeration resistance (integration)', () => {
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

  function send(phoneNumber: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/send',
      payload: { phoneNumber },
    });
  }

  function verify(phoneNumber: string, code: string, challengeId?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      headers: { 'idempotency-key': randomUUID() },
      payload: { phoneNumber, code, ...(challengeId ? { challengeId } : {}) },
    });
  }

  /** A response body with the per-request correlation id removed. */
  function stable(payload: string): unknown {
    const body = JSON.parse(payload) as Record<string, unknown> & {
      error?: Record<string, unknown>;
    };
    delete body.requestId;
    if (body.error) delete body.error.requestId;
    return body;
  }

  /**
   * Count calls to a method on a resolved singleton for the duration of `body`.
   *
   * The services hold the same instance the container does, so replacing a method
   * on it is observed by code that captured the reference at construction — the
   * trick the harness already uses to pin the OTP generator.
   */
  async function countCalls<T extends object, K extends keyof T>(
    target: T,
    method: K,
    body: () => Promise<void>,
  ): Promise<number> {
    const original = target[method] as (...args: unknown[]) => unknown;
    let calls = 0;
    target[method] = function counted(this: unknown, ...args: unknown[]) {
      calls += 1;
      return original.apply(this, args);
    } as T[K];
    try {
      await body();
    } finally {
      target[method] = original as T[K];
    }
    return calls;
  }

  // ── §4.4 bullet 1: send never reveals new vs returning ────────────────────

  describe('the send response', () => {
    it('is shaped identically for a registered and an unknown number', async () => {
      await loginAs(app, KNOWN);
      await redis.del(RedisKeys.otpChallenge('LOGIN', KNOWN));

      const known = await send(KNOWN);
      const unknown = await send(UNKNOWN);

      assert.equal(known.statusCode, 200);
      assert.equal(unknown.statusCode, 200);

      const a = known.json() as Record<string, unknown>;
      const b = unknown.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
      assert.equal(a.expiresInSec, b.expiresInSec);
      assert.equal(a.resendAvailableInSec, b.resendAvailableInSec);

      // The only field that differs is the opaque challenge id, and its *form*
      // is identical, so its presence reveals nothing either.
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert.match(String(a.challengeId), uuid);
      assert.match(String(b.challengeId), uuid);
      assert.notEqual(a.challengeId, b.challengeId);
    });

    it('creates no account, so send itself cannot be the probe', async () => {
      await send(UNKNOWN);
      // Account creation happens on first successful verify, never here
      // (doc 02 §4.4) — otherwise a probe would leave evidence of itself.
      assert.equal(await db().client.user.count({ where: { phoneNumber: UNKNOWN } }), 0);
    });
  });

  // ── §4.4 bullet 2: verify failures are merged ─────────────────────────────

  describe('the verify failure', () => {
    it('cannot tell "no account" from "wrong code"', async () => {
      await loginAs(app, KNOWN);
      await redis.del(RedisKeys.otpChallenge('LOGIN', KNOWN));
      const knownChallenge = (await send(KNOWN)).json().challengeId as string;
      const unknownChallenge = (await send(UNKNOWN)).json().challengeId as string;

      const onKnown = await verify(KNOWN, '000000', knownChallenge);
      const onUnknown = await verify(UNKNOWN, '000000', unknownChallenge);

      assert.equal(onKnown.statusCode, onUnknown.statusCode);
      assert.deepEqual(stable(onKnown.payload), stable(onUnknown.payload));
      assert.equal(onKnown.json().error.code, 'OTP_INVALID');
    });

    it('cannot tell a wrong code from a challenge that never existed', async () => {
      await loginAs(app, KNOWN);
      await redis.del(RedisKeys.otpChallenge('LOGIN', KNOWN));
      const challengeId = (await send(KNOWN)).json().challengeId as string;

      const wrongCode = await verify(KNOWN, '000000', challengeId);
      const noChallenge = await verify(KNOWN, '000000', randomUUID());

      assert.deepEqual(stable(wrongCode.payload), stable(noChallenge.payload));
    });

    it('cannot tell a wrong code from one already consumed', async () => {
      const challengeId = (await send(KNOWN)).json().challengeId as string;
      assert.equal((await verify(KNOWN, FIXED_OTP, challengeId)).statusCode, 200);

      const replayed = await verify(KNOWN, FIXED_OTP, challengeId);
      const wrong = await verify(KNOWN, '000000', challengeId);

      // A consumed code and a wrong code are the same answer: distinguishing
      // them tells an attacker their guess was right, only late.
      assert.equal(replayed.statusCode, 401);
      assert.deepEqual(stable(replayed.payload), stable(wrong.payload));
    });
  });

  // ── §4.4 bullet 3: the miss path does the same work ───────────────────────

  describe('the miss path does equal work either way', () => {
    it('hashes the presented code the same number of times', async () => {
      await loginAs(app, KNOWN);
      await redis.del(RedisKeys.otpChallenge('LOGIN', KNOWN));
      const knownChallenge = (await send(KNOWN)).json().challengeId as string;
      const unknownChallenge = (await send(UNKNOWN)).json().challengeId as string;

      const hasher = container.resolve<OtpHasher>('otpHasher');
      const onKnown = await countCalls(hasher, 'hash', async () => {
        await verify(KNOWN, '000000', knownChallenge);
      });
      const onUnknown = await countCalls(hasher, 'hash', async () => {
        await verify(UNKNOWN, '000000', unknownChallenge);
      });

      // This is doc 02 §4.4's "same hash/compare work on the miss path", asserted
      // as the mechanism rather than as elapsed milliseconds.
      assert.equal(onKnown, 1, 'the known-phone miss still hashes');
      assert.equal(onUnknown, onKnown, 'and the unknown-phone miss does the same');
    });

    it('never consults the account table on a failure', async () => {
      await loginAs(app, KNOWN);
      await redis.del(RedisKeys.otpChallenge('LOGIN', KNOWN));
      const challengeId = (await send(KNOWN)).json().challengeId as string;

      const users = container.resolve<UserRepository>('userRepository');
      const lookups = await countCalls(users, 'findActiveByPhone', async () => {
        assert.equal((await verify(KNOWN, '000000', challengeId)).statusCode, 401);
      });

      // The strongest form of the property, and the reason no stopwatch is
      // needed: the failure path contains no account-existence branch at all, so
      // there is nothing whose cost could differ between a known and an unknown
      // phone. A future lookup added here fails this test immediately, where a
      // timing assertion would only notice once the machine was quiet enough.
      assert.equal(lookups, 0);
    });

    it('does reach the account table on success, which is not a leak', async () => {
      const challengeId = (await send(UNKNOWN)).json().challengeId as string;

      const users = container.resolve<UserRepository>('userRepository');
      const lookups = await countCalls(users, 'findActiveByPhone', async () => {
        assert.equal((await verify(UNKNOWN, FIXED_OTP, challengeId)).statusCode, 200);
      });

      // The contrast that makes the previous test meaningful: the lookup exists,
      // and it is reached only once the caller has already proved control of the
      // number — at which point they know the answer anyway.
      assert.ok(lookups > 0);
    });
  });
});
