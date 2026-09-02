import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, loginAs, resetState } from './helpers/harness.js';

describe('maps public API (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });

  after(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    await resetState();
  });

  it('requires authentication for maps config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/maps/config' });
    assert.equal(res.statusCode, 401);
  });

  it('returns secret-free map config for authenticated users', async () => {
    const seed = await loginAs(app, '+919876545100');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/maps/config',
      headers: { authorization: `Bearer ${seed.accessToken}` },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.ok(body.primaryProvider);
    assert.equal(typeof body.configVersion, 'number');
    assert.ok(Array.isArray(body.capabilities));
    assert.ok(body.attribution?.text);
    assert.equal(body.providers.ola.clientSdkKey, undefined);
    assert.equal(body.providers.google.clientSdkKey, undefined);
  });

  it('autocomplete returns normalized envelope', async () => {
    const seed = await loginAs(app, '+919876545101');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/maps/places/autocomplete?input=connaught',
      headers: { authorization: `Bearer ${seed.accessToken}` },
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.ok(['ok', 'no_results', 'unavailable'].includes(body.status));
    assert.ok(Array.isArray(body.predictions));
  });
});
