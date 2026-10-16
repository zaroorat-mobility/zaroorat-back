import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { rateLimitsBypassed } from '../../../src/core/cache/stores/RateLimitStore.js';

const saved = {
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  RATE_LIMIT_BYPASS: process.env.RATE_LIMIT_BYPASS,
};

function setEnv(env: Partial<Record<keyof typeof saved, string | undefined>>): void {
  for (const key of Object.keys(saved) as Array<keyof typeof saved>) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('rate limit bypass fails closed', () => {
  afterEach(() => setEnv(saved));

  it('enforces when APP_ENV is missing', () => {
    setEnv({});
    assert.equal(rateLimitsBypassed(), false);
  });

  it('enforces when only NODE_ENV says development', () => {
    setEnv({ NODE_ENV: 'development', RATE_LIMIT_BYPASS: 'true' });
    assert.equal(rateLimitsBypassed(), false);
  });

  it('enforces in development without the explicit opt-in', () => {
    setEnv({ APP_ENV: 'development' });
    assert.equal(rateLimitsBypassed(), false);
  });

  it('enforces in production even with the opt-in set', () => {
    setEnv({ APP_ENV: 'production', RATE_LIMIT_BYPASS: 'true' });
    assert.equal(rateLimitsBypassed(), false);
  });

  it('bypasses only for APP_ENV=development with RATE_LIMIT_BYPASS=true', () => {
    setEnv({ APP_ENV: 'development', RATE_LIMIT_BYPASS: 'true' });
    assert.equal(rateLimitsBypassed(), true);
  });
});
