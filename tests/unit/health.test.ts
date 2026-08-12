import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../src/app/app.js';
import { clearReadinessChecks, registerReadinessCheck } from '../../src/core/health/index.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('responds 200 at the root path', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
  });

  it('responds 200 at the versioned path', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
  });

  it('reports uptime and a parseable timestamp', async () => {
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();

    assert.equal(typeof body.uptime, 'number');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  });
});

describe('GET /ready', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('responds 200 at the path the orchestrator probes', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ready');
  });

  it('responds 200 at the versioned path', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });

    assert.equal(response.statusCode, 200);
  });

  it('reports each registered check by name', async () => {
    registerReadinessCheck({ name: 'probe-under-test', probe: () => {} });
    try {
      const body = (await app.inject({ method: 'GET', url: '/ready' })).json();

      assert.deepEqual(body.checks, [{ name: 'probe-under-test', ok: true }]);
    } finally {
      clearReadinessChecks();
    }
  });
});
