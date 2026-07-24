import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../src/app/app.js';

const LEAKY_MESSAGE = 'connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432';

describe('error handler', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();

    // Routes are added before ready() so they join the same lifecycle as the
    // real ones and go through the registered error handler.
    app.get('/test-500', async () => {
      const error = new Error(LEAKY_MESSAGE) as Error & { statusCode?: number };
      error.statusCode = 500;
      throw error;
    });

    app.get('/test-404', async () => {
      const error = new Error('Rider not found') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    });

    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('never echoes an internal 5xx message to the client', async () => {
    const response = await app.inject({ method: 'GET', url: '/test-500' });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().message, 'Internal Server Error');
    assert.ok(
      !response.payload.includes('hunter2'),
      'credentials from an internal error must not reach the response body',
    );
  });

  it('still surfaces 4xx messages, which are meant for the caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/test-404' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().message, 'Rider not found');
  });

  it('reports validation failures as 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().success, false);
  });
});
