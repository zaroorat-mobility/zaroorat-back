import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../../src/app/app.js';

// Proves the deny-by-default auth gate (auth doc 02 §6, doc 07 §3 row 5): a route
// with no explicit posture is protected, `config: { public: true }` opts out, and
// unmatched paths still 404. The deny path rejects on the missing bearer token
// before any Redis work, so this runs without live infra.
describe('deny-by-default auth gate', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();

    // An ordinary route that forgets to declare a posture — must be protected.
    app.get('/test-guarded', async () => ({ ok: true }));
    // An explicitly public route — must be reachable without a token.
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
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
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
