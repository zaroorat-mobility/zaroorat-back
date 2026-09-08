import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hashRidePin,
  verifyRidePin,
  isBlockedRidePin,
  isWellFormedRidePin,
} from '../../../src/modules/auth/utils/ride-pin.js';
import { RidePinService } from '../../../src/modules/users/services/ride-pin/ride-pin.service.js';
import {
  RidePinAlreadySetError,
  RidePinInvalidError,
  RidePinWeakError,
} from '../../../src/modules/users/errors/user.errors.js';

function makeService(seed: { verifier: string | null; version?: number }) {
  const state = {
    id: 'user-1',
    phoneNumber: '+919000000001',
    status: 'ACTIVE' as string,
    deletedAt: null as Date | null,
    ridePinVerifier: seed.verifier,
    ridePinUpdatedAt: null as Date | null,
    ridePinVersion: seed.version ?? (seed.verifier ? 1 : 0),
  };
  const published: { type: string; data: Record<string, unknown> }[] = [];
  const otpSent: { phoneNumber: string; purpose: string }[] = [];
  const otpVerified: { purpose: string; code: string }[] = [];

  const userRepository = {
    async findById() {
      return { ...state };
    },
    async setRidePin(_id: string, verifier: string) {
      state.ridePinVerifier = verifier;
      state.ridePinUpdatedAt = new Date();
      state.ridePinVersion += 1;
      return state.ridePinVersion;
    },
  };
  const otpService = {
    async send(input: { phoneNumber: string; purpose: string }) {
      otpSent.push({ phoneNumber: input.phoneNumber, purpose: input.purpose });
      return { challengeId: 'ch-1', expiresInSec: 300, resendAvailableInSec: 60 };
    },
    async verify(input: { purpose: string; code: string }) {
      otpVerified.push({ purpose: input.purpose, code: input.code });
      if (input.code !== '111111') throw new Error('bad otp');
    },
  };
  const redisService = {
    rateLimit: {
      async hit() {
        return { allowed: true, current: 1, remaining: 4, retryAfterSeconds: 0 };
      },
    },
  };
  const eventPublisher = {
    async publish(input: { type: string; data: Record<string, unknown> }) {
      published.push({ type: input.type, data: input.data });
    },
  };
  const userMetrics = {
    ridePinChanged() {},
    ridePinRejected() {},
    ridePinRateLimited() {},
  };

  return {
    state,
    published,
    otpSent,
    otpVerified,
    service: new RidePinService(
      userRepository as never,
      otpService as never,
      redisService as never,
      eventPublisher as never,
      userMetrics as never,
    ),
  };
}

describe('Ride PIN verifier', () => {
  it('never stores the PIN, and salts so two riders with the same PIN differ', () => {
    const a = hashRidePin('4827');
    const b = hashRidePin('4827');
    assert.ok(!a.includes('4827'));
    // The whole reason this does not use OtpHasher: an unsalted digest would
    // make these equal, and a database dump could then be bucketed by verifier
    // and read off by frequency with no secret at all.
    assert.notEqual(a, b);
    assert.ok(a.startsWith('scrypt$'));
  });

  it('accepts the correct PIN and rejects a wrong one', () => {
    const verifier = hashRidePin('4827');
    assert.equal(verifyRidePin('4827', verifier), true);
    assert.equal(verifyRidePin('4826', verifier), false);
  });

  it('rejects against a rider with no PIN configured rather than throwing', () => {
    assert.equal(verifyRidePin('4827', null), false);
  });

  it('round-trips leading zeros', () => {
    for (const pin of ['0000', '0001', '0827']) {
      assert.equal(verifyRidePin(pin, hashRidePin(pin)), true, pin);
    }
    // The failure this guards: Number('0827') === 827, which would hash as a
    // different credential and lock the rider out of every future ride.
    assert.equal(verifyRidePin('827', hashRidePin('0827')), false);
  });

  it('accepts exactly four digits', () => {
    for (const good of ['0000', '9999', '0827']) assert.ok(isWellFormedRidePin(good), good);
    for (const bad of ['123', '12345', 'abcd', '12 4', '', '12.4']) {
      assert.ok(!isWellFormedRidePin(bad), bad);
    }
  });

  it('blocks the predictable PINs and allows ordinary ones', () => {
    for (const weak of ['0000', '1111', '9999', '1234', '4321', '2109']) {
      assert.ok(isBlockedRidePin(weak), weak);
    }
    for (const fine of ['4827', '1938', '0827', '5150']) {
      assert.ok(!isBlockedRidePin(fine), fine);
    }
  });
});

describe('RidePinService', () => {
  it('sets a first PIN without requiring the current one', async () => {
    const world = makeService({ verifier: null });
    const status = await world.service.setPin({ userId: 'user-1', newPin: '4827' });
    assert.equal(status.configured, true);
    assert.equal(status.version, 1);
    assert.equal(verifyRidePin('4827', world.state.ridePinVerifier), true);
    assert.deepEqual(world.published[0]?.type, 'user.ride_pin.changed');
    assert.equal(world.published[0]?.data.method, 'set');
  });

  it('refuses a change that omits the current PIN once one exists', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    await assert.rejects(
      () => world.service.setPin({ userId: 'user-1', newPin: '1938' }),
      (err: unknown) => err instanceof RidePinAlreadySetError,
    );
  });

  it('refuses a change with the wrong current PIN', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    await assert.rejects(
      () => world.service.setPin({ userId: 'user-1', currentPin: '1111', newPin: '1938' }),
      (err: unknown) => err instanceof RidePinInvalidError,
    );
    assert.equal(verifyRidePin('4827', world.state.ridePinVerifier), true);
  });

  it('changes the PIN and bumps the version', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    const status = await world.service.setPin({
      userId: 'user-1',
      currentPin: '4827',
      newPin: '1938',
    });
    assert.equal(status.version, 2);
    assert.equal(verifyRidePin('1938', world.state.ridePinVerifier), true);
    assert.equal(world.published[0]?.data.method, 'change');
  });

  it('refuses a blocklisted new PIN', async () => {
    const world = makeService({ verifier: null });
    await assert.rejects(
      () => world.service.setPin({ userId: 'user-1', newPin: '1234' }),
      (err: unknown) => err instanceof RidePinWeakError,
    );
    assert.equal(world.state.ridePinVerifier, null);
  });

  it('sends the reset code to the number on the account, under its own purpose', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    await world.service.requestReset({ userId: 'user-1' });
    assert.deepEqual(world.otpSent, [{ phoneNumber: '+919000000001', purpose: 'RIDE_PIN_RESET' }]);
  });

  it('resets to a new PIN on a valid code, without needing the old one', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    const status = await world.service.verifyReset({
      userId: 'user-1',
      challengeId: 'ch-1',
      code: '111111',
      newPin: '1938',
    });
    assert.equal(status.version, 2);
    assert.equal(verifyRidePin('1938', world.state.ridePinVerifier), true);
    assert.equal(world.published[0]?.data.method, 'reset');
  });

  it('leaves the PIN alone when the reset code is wrong', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    await assert.rejects(() =>
      world.service.verifyReset({
        userId: 'user-1',
        challengeId: 'ch-1',
        code: '222222',
        newPin: '1938',
      }),
    );
    assert.equal(verifyRidePin('4827', world.state.ridePinVerifier), true);
  });

  it('rejects a weak replacement before spending the reset code', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    await assert.rejects(
      () =>
        world.service.verifyReset({
          userId: 'user-1',
          challengeId: 'ch-1',
          code: '111111',
          newPin: '1111',
        }),
      (err: unknown) => err instanceof RidePinWeakError,
    );
    // The code is still unspent, so the rider does not have to request another
    // one just to be told something the server already knew.
    assert.deepEqual(world.otpVerified, []);
  });

  it('never puts PIN material in the audit event', async () => {
    const world = makeService({ verifier: null });
    await world.service.setPin({ userId: 'user-1', newPin: '4827' });
    const payload = JSON.stringify(world.published[0]?.data ?? {});
    assert.ok(!payload.includes('4827'));
    assert.ok(!payload.includes('scrypt'));
  });

  it('never returns the PIN from status', async () => {
    const world = makeService({ verifier: hashRidePin('4827') });
    const status = await world.service.status('user-1');
    assert.deepEqual(Object.keys(status).sort(), ['configured', 'updatedAt', 'version']);
    assert.ok(!JSON.stringify(status).includes('4827'));
    assert.ok(!JSON.stringify(status).includes('scrypt'));
  });
});
