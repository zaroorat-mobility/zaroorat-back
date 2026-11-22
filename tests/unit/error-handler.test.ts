import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../src/app/app.js';

const LEAKY_MESSAGE = 'connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432';

describe('error handler', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await createApp();

    app.get('/test-500', { config: { public: true } }, async () => {
      const error = new Error(LEAKY_MESSAGE) as Error & { statusCode?: number };
      error.statusCode = 500;
      throw error;
    });

    app.get('/test-404', { config: { public: true } }, async () => {
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
    assert.equal(response.json().error.message, 'Internal Server Error');
    assert.equal(response.json().error.code, 'INTERNAL');
    assert.ok(
      !response.payload.includes('hunter2'),
      'credentials from an internal error must not reach the response body',
    );
  });

  it('still surfaces 4xx messages, which are meant for the caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/test-404' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.message, 'Rider not found');
    assert.equal(response.json().error.code, 'NOT_FOUND');
  });

  it('answers an unmatched route WITHOUT a domain error object', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().success, false);
    assert.equal(response.json().error, undefined);
  });

  it('carries every field the route error schemas declare required', async () => {
    for (const url of ['/test-404', '/test-500']) {
      const body = (await app.inject({ method: 'GET', url })).json();
      for (const field of ['code', 'messageKey', 'message', 'requestId']) {
        assert.ok(
          typeof body.error?.[field] === 'string' && body.error[field].length > 0,
          `${url} → error.${field} is missing; the response serializer will reject this`,
        );
      }
    }
  });

  it('reports a schema-validation failure as 400, not 500', async () => {
    const validating = await createApp();
    validating.post(
      '/needs-body',
      {
        config: { public: true },
        schema: {
          body: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
          response: {
            400: {
              type: 'object',
              properties: {
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    messageKey: { type: 'string' },
                    message: { type: 'string' },
                    requestId: { type: 'string' },
                  },
                  required: ['code', 'messageKey', 'message', 'requestId'],
                },
              },
              required: ['error'],
            },
          },
        },
      },
      async () => ({ ok: true }),
    );
    await validating.ready();

    try {
      const response = await validating.inject({
        method: 'POST',
        url: '/needs-body',
        payload: {},
      });

      assert.equal(response.statusCode, 400, 'must not degrade to 500');
      assert.equal(response.json().error.code, 'VALIDATION');
    } finally {
      await validating.close();
    }
  });
});
