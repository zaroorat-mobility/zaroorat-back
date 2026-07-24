import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../src/app/app.js';

// Smoke test: boots the real Fastify app in-process (no socket, no DB) and
// exercises the load-balancer health contract from docs/04_Architecture/05_deployment-architecture.md "Zero-downtime deploys".
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

// The Helm readiness probe targets this exact path. If it 404s, pods never
// become ready and every `helm upgrade --wait` hangs until it times out.
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
});
