import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../../src/app/app.js';

describe('deny-by-default auth gate', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();

    app.get('/test-guarded', async () => ({ ok: true }));

    app.get('/test-public', { config: { public: true } }, async () => ({ ok: true }));

    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('protects an unguarded route by default (401 without a token)', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-guarded' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'TOKEN_INVALID');
  });

  it('lets an explicitly public route through', async () => {
    const res = await app.inject({ method: 'GET', url: '/test-public' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  it('protects the real logout endpoint without a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'TOKEN_INVALID');
  });

  it('keeps the health probe public', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
  });

  it('still 404s an unknown path (unmatched routes are not turned into 401s)', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    assert.equal(res.statusCode, 404);
  });
});
