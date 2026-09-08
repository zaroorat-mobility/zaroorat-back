import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashRidePin } from '../../../src/modules/auth/utils/ride-pin.js';
import { RidePinVerificationService } from '../../../src/modules/rides/services/pin/ride-pin-verification.service.js';
import { RidePinThrottle } from '../../../src/modules/rides/services/pin/ride-pin-throttle.service.js';
import {
  RidePinInvalidError,
  RidePinLockedError,
  RidePinThrottledError,
  RidePinUnavailableError,
} from '../../../src/modules/rides/errors/ride.errors.js';
import { ridePinConfig } from '../../../src/config/ride-pin/ride-pin.config.js';

function metricsSpy() {
  const seen: { name: string; fields: Record<string, unknown> }[] = [];
  const record =
    (name: string) =>
    (fields: Record<string, unknown> = {}) =>
      void seen.push({ name, fields });
  return {
    seen,
    ridePinVerified: record('verified'),
    ridePinFailed: record('failed'),
    ridePinLocked: record('locked'),
  };
}

function verifier(rows: Record<string, { verifier: string | null; version: number }>) {
  return new RidePinVerificationService(
    {
      async findRidePin(id: string) {
        const row = rows[id];
        return row ? { ridePinVerifier: row.verifier, ridePinVersion: row.version } : null;
      },
    } as never,
    metricsSpy() as never,
  );
}

/// An in-memory stand-in for Redis that behaves like the real store for the
/// three operations the throttle uses. Counters live outside any notion of a
/// transaction here — which is the entire property under test.
function fakeRedis(options: { down?: boolean } = {}) {
  const counters = new Map<string, number>();
  const gaps = new Set<string>();
  const fail = () => {
    if (options.down) throw new Error('redis is down');
  };
  return {
    counters,
    gaps,
    rateLimit: {
      async peek(scope: string, id: string, limit: number) {
        fail();
        const current = counters.get(`${scope}:${id}`) ?? 0;
        return {
          allowed: current < limit,
          current,
          remaining: Math.max(0, limit - current),
          retryAfterSeconds: current > 0 ? 60 : 0,
        };
      },
      async hit(scope: string, id: string, limit: number) {
        fail();
        const key = `${scope}:${id}`;
        const current = (counters.get(key) ?? 0) + 1;
        counters.set(key, current);
        return {
          allowed: current <= limit,
          current,
          remaining: Math.max(0, limit - current),
          retryAfterSeconds: 60,
        };
      },
      async reset(scope: string, id: string) {
        fail();
        counters.delete(`${scope}:${id}`);
      },
      async enforceMinInterval(scope: string, id: string) {
        fail();
        const key = `${scope}:gap:${id}`;
        if (gaps.has(key)) return { allowed: false, retryAfterSeconds: 2 };
        gaps.add(key);
        return { allowed: true, retryAfterSeconds: 0 };
      },
    },
  };
}

const ATTEMPT = { rideId: 'ride-1', driverId: 'drv-1', customerId: 'cus-1' };

describe('RidePinVerificationService', () => {
  it('accepts the PIN of the customer who owns the ride', async () => {
    const service = verifier({ 'cus-1': { verifier: hashRidePin('4827'), version: 3 } });
    assert.deepEqual(await service.verify('cus-1', '4827', {} as never), { version: 3 });
  });

  it('rejects a wrong PIN', async () => {
    const service = verifier({ 'cus-1': { verifier: hashRidePin('4827'), version: 1 } });
    await assert.rejects(
      () => service.verify('cus-1', '1234', {} as never),
      (err: unknown) => err instanceof RidePinInvalidError,
    );
  });

  it("refuses another customer's PIN even though four digits are not unique", async () => {
    // Both riders legitimately chose 4827. The PIN alone means nothing; whose
    // account it is checked against is the entire control.
    const service = verifier({
      'cus-1': { verifier: hashRidePin('4827'), version: 1 },
      'cus-2': { verifier: hashRidePin('4827'), version: 1 },
    });
    assert.deepEqual(await service.verify('cus-2', '4827', {} as never), { version: 1 });
    await assert.rejects(
      () => service.verify('cus-2', '1938', {} as never),
      (err: unknown) => err instanceof RidePinInvalidError,
    );
  });

  it('answers identically for a customer with no PIN and a wrong PIN', async () => {
    const unset = verifier({ 'cus-1': { verifier: null, version: 0 } });
    const wrong = verifier({ 'cus-1': { verifier: hashRidePin('4827'), version: 1 } });
    const errors: RidePinInvalidError[] = [];
    for (const service of [unset, wrong]) {
      await service.verify('cus-1', '1234', {} as never).catch((err) => errors.push(err));
    }
    assert.equal(errors.length, 2);
    // Same class, same code, same message: the start endpoint must not tell a
    // driver which riders are unprotected.
    assert.equal(errors[0]!.code, errors[1]!.code);
    assert.equal(errors[0]!.message, errors[1]!.message);
    assert.equal(errors[0]!.statusCode, 400);
  });

  it('answers the same way for a customer row that does not exist', async () => {
    const service = verifier({});
    await assert.rejects(
      () => service.verify('missing', '4827', {} as never),
      (err: unknown) => err instanceof RidePinInvalidError,
    );
  });

  it('never puts PIN material in the thrown error', async () => {
    const service = verifier({ 'cus-1': { verifier: hashRidePin('4827'), version: 1 } });
    const err = await service.verify('cus-1', '1234', {} as never).catch((e) => e);
    const rendered = `${err.message}${JSON.stringify(err.details ?? {})}`;
    assert.ok(!rendered.includes('1234'));
    assert.ok(!rendered.includes('4827'));
    assert.ok(!rendered.includes('scrypt'));
  });

  it('counts every rejection, including the not-configured one', async () => {
    const metrics = metricsSpy();
    const service = new RidePinVerificationService(
      {
        async findRidePin() {
          return { ridePinVerifier: null, ridePinVersion: 0 };
        },
      } as never,
      metrics as never,
    );
    await service.verify('cus-1', '1234', {} as never).catch(() => {});
    assert.deepEqual(metrics.seen, [{ name: 'failed', fields: { reason: 'unset' } }]);
  });
});

describe('RidePinThrottle', () => {
  it('allows a first attempt', async () => {
    const redis = fakeRedis();
    const throttle = new RidePinThrottle(redis as never, metricsSpy() as never);
    await throttle.assertAllowed(ATTEMPT);
  });

  it('does not spend a budget on an attempt that succeeds', async () => {
    const redis = fakeRedis();
    const throttle = new RidePinThrottle(redis as never, metricsSpy() as never);
    await throttle.assertAllowed(ATTEMPT);
    // No recordFailure: the PIN was right. A budget spent on success would lock
    // an honest driver out partway through a normal working day.
    assert.equal(redis.counters.size, 0);
  });

  it('locks the ride out once its failure budget is spent', async () => {
    const redis = fakeRedis();
    const metrics = metricsSpy();
    const throttle = new RidePinThrottle(redis as never, metrics as never);
    for (let i = 0; i < ridePinConfig.verifyRideLimit; i += 1) {
      redis.gaps.clear();
      await throttle.assertAllowed(ATTEMPT);
      await throttle.recordFailure(ATTEMPT);
    }
    redis.gaps.clear();
    await assert.rejects(
      () => throttle.assertAllowed(ATTEMPT),
      (err: unknown) => err instanceof RidePinLockedError,
    );
    assert.deepEqual(metrics.seen, [{ name: 'locked', fields: { scope: 'ride:pin:ride' } }]);
  });

  it('locks on the driver budget across many different riders', async () => {
    const redis = fakeRedis();
    const metrics = metricsSpy();
    const throttle = new RidePinThrottle(redis as never, metrics as never);
    // One guess each against many riders — invisible to a per-ride cap, and the
    // exact shape a colluding driver would use.
    for (let i = 0; i < ridePinConfig.verifyDriverLimit; i += 1) {
      const attempt = { rideId: `ride-${i}`, driverId: 'drv-1', customerId: `cus-${i}` };
      await throttle.assertAllowed(attempt);
      await throttle.recordFailure(attempt);
    }
    await assert.rejects(
      () => throttle.assertAllowed({ rideId: 'ride-x', driverId: 'drv-1', customerId: 'cus-x' }),
      (err: unknown) => err instanceof RidePinLockedError,
    );
    assert.equal(metrics.seen.at(-1)?.fields.scope, 'ride:pin:drv');
  });

  it('enforces a cooldown between two attempts on the same ride', async () => {
    const redis = fakeRedis();
    const throttle = new RidePinThrottle(redis as never, metricsSpy() as never);
    await throttle.assertAllowed(ATTEMPT);
    await assert.rejects(
      () => throttle.assertAllowed(ATTEMPT),
      (err: unknown) => err instanceof RidePinThrottledError,
    );
  });

  it('forgives the ride budget on success but keeps the driver and customer ones', async () => {
    const redis = fakeRedis();
    const throttle = new RidePinThrottle(redis as never, metricsSpy() as never);
    await throttle.recordFailure(ATTEMPT);
    await throttle.clear(ATTEMPT.rideId);
    assert.equal(redis.counters.get('ride:pin:ride:ride-1'), undefined);
    // A driver who guessed wrong before getting it right has still guessed
    // wrong; one success must not launder that history.
    assert.equal(redis.counters.get('ride:pin:drv:drv-1'), 1);
    assert.equal(redis.counters.get('ride:pin:cust:cus-1'), 1);
  });

  it('fails closed when the throttle store is unreachable', async () => {
    const throttle = new RidePinThrottle(fakeRedis({ down: true }) as never, metricsSpy() as never);
    await assert.rejects(
      () => throttle.assertAllowed(ATTEMPT),
      (err: unknown) => err instanceof RidePinUnavailableError && err.statusCode === 503,
    );
  });

  it('does not turn a wrong PIN into a 503 when recording the failure fails', async () => {
    const throttle = new RidePinThrottle(fakeRedis({ down: true }) as never, metricsSpy() as never);
    // Telling the driver the PIN was fine, or that the service is down, when the
    // PIN was actually wrong would be worse than losing one increment.
    await throttle.recordFailure(ATTEMPT);
    await throttle.clear(ATTEMPT.rideId);
  });

  /// The regression test for the bug this whole design exists to avoid.
  ///
  /// The OTP implementation counted attempts with a conditional UPDATE on the
  /// ride transaction and then threw, so the throw rolled the increment back and
  /// the cap never engaged. Its unit test passed because the fake repository had
  /// no transaction to roll back.
  ///
  /// Here the "transaction" genuinely rolls back and the counter genuinely has
  /// to survive it.
  it('keeps failed attempts after the ride transaction rolls back', async () => {
    const redis = fakeRedis();
    const throttle = new RidePinThrottle(redis as never, metricsSpy() as never);
    const committed = new Map<string, string>();

    async function startRide(pin: string): Promise<void> {
      redis.gaps.clear();
      await throttle.assertAllowed(ATTEMPT);
      const staged = new Map(committed);
      try {
        staged.set('status', 'IN_PROGRESS');
        if (pin !== '4827') throw new RidePinInvalidError();
        for (const [k, v] of staged) committed.set(k, v);
      } catch (err) {
        staged.clear(); // rollback: everything written inside is discarded
        await throttle.recordFailure(ATTEMPT);
        throw err;
      }
    }

    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => startRide('0000'));
    }
    assert.equal(committed.size, 0, 'no failed start may commit');
    assert.equal(
      redis.counters.get('ride:pin:ride:ride-1'),
      3,
      'the attempt count must outlive the rolled-back transaction',
    );
  });
});
