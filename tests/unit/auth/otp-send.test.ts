import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OtpService } from '../../../src/modules/auth/services/otp/otp.service.js';
import { RateLimitedError } from '../../../src/modules/auth/errors/auth.errors.js';
import type { ClaimChallengeResult } from '../../../src/core/cache/stores/OtpStore.js';
import type { OtpDeliveryJobData } from '../../../src/jobs/producers/index.js';
import { makeOtpConfig } from '../../helpers/config.js';

const PHONE = '+919000000000';
const input = { phoneNumber: PHONE, purpose: 'LOGIN' as const };

function makeService(
  opts: {
    claim?: ClaimChallengeResult;
    enqueueFails?: boolean;
    createFails?: boolean;
    secondaryAllowed?: boolean;
  } = {},
) {
  const enqueued: OtpDeliveryJobData[] = [];
  const calls = {
    released: 0,
    secretsCleared: 0,
    smsSent: 0,
    storedHashes: [] as string[],
    claimArgs: null as unknown,
  };

  const claim: ClaimChallengeResult = opts.claim ?? { status: 'claimed', payload: '{"claim":1}' };

  const redisService = {
    otp: {
      claimChallenge: async (...args: unknown[]) => {
        calls.claimArgs = args;
        return claim;
      },
      releaseChallenge: async () => {
        calls.released += 1;
        return true;
      },
      clearSecret: async () => {
        calls.secretsCleared += 1;
      },
      store: async (_p: string, _ph: string, hash: string) => {
        calls.storedHashes.push(hash);
      },
    },
  };

  const service = new OtpService(
    { generate: () => '123456' } as never,
    { hash: (code: string) => `hash(${code})` } as never,
    { isValidFormat: () => true } as never,
    {
      checkSecondaryAxes: async () => ({
        allowed: opts.secondaryAllowed ?? true,
        retryAfterSeconds: 42,
      }),
    } as never,
    redisService as never,
    {
      create: async (data: { id?: string }) => {
        if (opts.createFails) throw new Error('database is down');
        return { id: data.id };
      },
    } as never,
    {
      sendOtp: async () => {
        calls.smsSent += 1;
        return { accepted: true, provider: 'mock' };
      },
    } as never,
    { queued: () => {}, rateLimited: () => {} } as never,
    { publish: async () => {} } as never,
    makeOtpConfig(),
    {
      enqueue: async (data: OtpDeliveryJobData) => {
        if (opts.enqueueFails) throw new Error('queue unreachable');
        enqueued.push(data);
      },
    } as never,
  );

  return { service, enqueued, calls };
}

describe('OtpService.send — atomic slot claim (H-2)', () => {
  it('never calls the SMS provider from the request path', async () => {
    const { service, calls } = makeService();
    await service.send(input);

    assert.equal(calls.smsSent, 0);
  });

  it('claims cooldown and the per-phone budget in a single Redis call', async () => {
    const { service, calls } = makeService();
    await service.send(input);

    const args = calls.claimArgs as [string, string, { challengeId: string }, unknown];
    assert.equal(args[0], 'LOGIN', 'the claim is purpose-scoped');
    assert.equal(args[1], PHONE);
    assert.match(
      args[2].challengeId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'the challenge id is minted up front, as a v7 uuid',
    );
  });

  it('returns the winner’s challenge to a caller that lost the claim', async () => {
    const { service, enqueued, calls } = makeService({
      claim: {
        status: 'active',
        challenge: {
          challengeId: 'winner-1',
          otpExpiresAt: Date.now() + 120_000,
          resendTtlSeconds: 45,
        },
      },
    });

    const result = await service.send(input);

    assert.equal(result.challengeId, 'winner-1', 'both callers see one challenge');
    assert.equal(result.resendAvailableInSec, 45);
    assert.deepEqual(enqueued, [], 'and only the winner queues an SMS');
    assert.deepEqual(calls.storedHashes, [], 'no second code is minted');
  });

  it('refuses once the per-phone budget is spent, carrying the window’s retry-after', async () => {
    const { service } = makeService({
      claim: { status: 'rate_limited', retryAfterSeconds: 1800 },
    });

    await assert.rejects(
      () => service.send(input),
      (err: RateLimitedError) => {
        assert.equal(err.code, 'RATE_LIMITED');
        assert.equal(err.retryAfterSeconds, 1800);
        return true;
      },
    );
  });

  it('hands the slot back when a secondary axis rejects', async () => {
    const { service, calls } = makeService({ secondaryAllowed: false });

    await assert.rejects(() => service.send(input), RateLimitedError);
    assert.equal(calls.released, 1, 'the cooldown must not be spent on a device/IP rejection');
    assert.deepEqual(calls.storedHashes, [], 'and no code was minted');
  });
});

describe('OtpService.send — queue failure semantics', () => {
  it('enqueues the plaintext code against the pre-minted challenge id', async () => {
    const { service, enqueued } = makeService();
    const result = await service.send(input);

    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]?.challengeId, result.challengeId);
    assert.equal(enqueued[0]?.code, '123456');
    assert.equal(enqueued[0]?.purpose, 'LOGIN');
  });

  it('stores only the digest, never the code', async () => {
    const { service, calls } = makeService();
    await service.send(input);

    assert.deepEqual(calls.storedHashes, ['hash(123456)']);
  });

  it('fails the request and consumes no cooldown when the enqueue fails', async () => {
    const { service, calls } = makeService({ enqueueFails: true });

    await assert.rejects(() => service.send(input), /queue unreachable/);

    assert.equal(calls.released, 1, 'the cooldown claim was handed back');
    assert.equal(calls.secretsCleared, 1, 'and the unusable secret was dropped');
  });

  it('does the same when the audit row cannot be written', async () => {
    const { service, calls, enqueued } = makeService({ createFails: true });

    await assert.rejects(() => service.send(input), /database is down/);

    assert.equal(calls.released, 1);
    assert.equal(calls.secretsCleared, 1);
    assert.deepEqual(enqueued, [], 'nothing was queued, so nothing claims to be sent');
  });

  it('reports a successful hand-off as queued, with the configured windows', async () => {
    const { service } = makeService();
    const result = await service.send(input);

    assert.equal(result.expiresInSec, 300);
    assert.equal(result.resendAvailableInSec, 60);
  });
});
