import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isRetryableProviderError,
  isTimeoutError,
  ProviderHttpError,
  retryIdempotent,
} from '../../../src/integrations/provider-http-error.js';

/// The map clients previously threw a bare `Error` whose message merely contained
/// the status, so everything downstream became one 503 and nothing could tell a
/// revoked key from an exhausted quota from a real outage. They also had no retry
/// at all, so one dropped packet failed a fare quote.
describe('provider http error classification', () => {
  it('classifies auth failures on 401 and 403 only', () => {
    assert.equal(new ProviderHttpError('Ola Maps', 401, '').isAuthFailure, true);
    assert.equal(new ProviderHttpError('Ola Maps', 403, '').isAuthFailure, true);
    assert.equal(new ProviderHttpError('Ola Maps', 429, '').isAuthFailure, false);
    assert.equal(new ProviderHttpError('Ola Maps', 500, '').isAuthFailure, false);
  });

  it('classifies quota failures on 429 only', () => {
    assert.equal(new ProviderHttpError('Google Maps', 429, '').isQuotaFailure, true);
    assert.equal(new ProviderHttpError('Google Maps', 403, '').isQuotaFailure, false);
  });

  it('names the provider and status in the message without inventing a body', () => {
    assert.equal(new ProviderHttpError('Mappls', 502, '').message, 'Mappls API error (502)');
    assert.equal(
      new ProviderHttpError('Mappls', 502, 'upstream down').message,
      'Mappls API error (502): upstream down',
    );
  });

  it('recognises the timeout shapes AbortSignal.timeout can produce', () => {
    assert.equal(isTimeoutError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
    assert.equal(isTimeoutError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
    assert.equal(isTimeoutError(new Error('plain')), false);
    assert.equal(isTimeoutError(null), false);
    assert.equal(isTimeoutError(undefined), false);
  });

  it('retries 5xx, timeouts and transport failures but never 429 or 4xx', () => {
    assert.equal(isRetryableProviderError(new ProviderHttpError('Ola Maps', 500, '')), true);
    assert.equal(isRetryableProviderError(new ProviderHttpError('Ola Maps', 503, '')), true);
    // Replaying a rate limit inside the backoff window spends the remaining
    // budget faster — that is how a throttle becomes an outage.
    assert.equal(isRetryableProviderError(new ProviderHttpError('Ola Maps', 429, '')), false);
    assert.equal(isRetryableProviderError(new ProviderHttpError('Ola Maps', 401, '')), false);
    assert.equal(isRetryableProviderError(new ProviderHttpError('Ola Maps', 400, '')), false);
    assert.equal(
      isRetryableProviderError(Object.assign(new Error('x'), { name: 'TimeoutError' })),
      true,
    );
    // fetch reports DNS/refused/reset as a TypeError with no status.
    assert.equal(isRetryableProviderError(new TypeError('fetch failed')), true);
  });
});

describe('retryIdempotent', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await retryIdempotent(async () => {
      calls++;
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries a 5xx and returns a later success', async () => {
    let calls = 0;
    const result = await retryIdempotent(
      async () => {
        calls++;
        if (calls < 3) throw new ProviderHttpError('Ola Maps', 503, '');
        return 'recovered';
      },
      { baseDelayMs: 1 },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    let calls = 0;
    await assert.rejects(
      retryIdempotent(
        async () => {
          calls++;
          throw new ProviderHttpError('Ola Maps', 503, 'still down');
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 503,
    );
    assert.equal(calls, 3);
  });

  it('does not retry a non-retryable error', async () => {
    let calls = 0;
    await assert.rejects(
      retryIdempotent(
        async () => {
          calls++;
          throw new ProviderHttpError('Ola Maps', 401, 'bad key');
        },
        { baseDelayMs: 1 },
      ),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 401,
    );
    assert.equal(calls, 1, 'a rejected credential must not be replayed');
  });
});
