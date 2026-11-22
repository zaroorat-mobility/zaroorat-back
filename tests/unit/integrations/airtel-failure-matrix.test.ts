import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AirtelProvider } from '../../../src/integrations/airtel/airtel.client.js';

describe('AirtelProvider — Automated Failure Test Matrix (Phase 3)', () => {
  const baseConfig = {
    apiKey: 'test_airtel_api_key_12345',
    customerId: 'CUST_998877',
    senderId: 'ZAROOR',
    entityId: '1001992837465012938',
    timeoutMs: 5000,
  };

  const sampleMessage = {
    to: '+919876543210',
    body: 'Your OTP is 123456',
    templateId: '1107161234567890123',
    variables: { otp: '123456' },
  };

  describe('HTTP Success Scenarios', () => {
    it('handles HTTP 200 with status=SUCCESS and extracts providerRef (requestId/messageId)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            statusCode: 200,
            status: 'SUCCESS',
            requestId: 'REQ_ABC_123',
            messageId: 'MSG_XYZ_789',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;

      try {
        const provider = new AirtelProvider(baseConfig);
        const res = await provider.sendSms(sampleMessage);
        assert.equal(res.accepted, true);
        assert.equal(res.provider, 'airtel');
        assert.equal(res.providerRef, 'REQ_ABC_123');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('handles HTTP 200 with fallback to messageId when requestId is missing', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            statusCode: '200',
            status: 'OK',
            messageId: 'MSG_ONLY_456',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;

      try {
        const provider = new AirtelProvider(baseConfig);
        const res = await provider.sendSms(sampleMessage);
        assert.equal(res.accepted, true);
        assert.equal(res.providerRef, 'MSG_ONLY_456');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('handles malformed HTTP 200 response cleanly (missing body/invalid format)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response('Not valid JSON', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }) as typeof fetch;

      try {
        const provider = new AirtelProvider(baseConfig);
        const res = await provider.sendSms(sampleMessage);
        assert.equal(res.accepted, false);
        assert.equal(res.retryable, false);
        assert.match(res.error ?? '', /HTTP 200/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('HTTP Error Matrix & Retryability (Phase 3)', () => {
    const errorCodes = [
      { status: 400, label: 'Bad Request', expectedRetryable: false },
      { status: 401, label: 'Unauthorized', expectedRetryable: false },
      { status: 403, label: 'Forbidden', expectedRetryable: false },
      { status: 404, label: 'Not Found', expectedRetryable: false },
      { status: 409, label: 'Conflict', expectedRetryable: false },
      { status: 422, label: 'Unprocessable Entity', expectedRetryable: false },
      { status: 429, label: 'Too Many Requests', expectedRetryable: true },
      { status: 500, label: 'Internal Server Error', expectedRetryable: true },
      { status: 502, label: 'Bad Gateway', expectedRetryable: true },
      { status: 503, label: 'Service Unavailable', expectedRetryable: true },
      { status: 504, label: 'Gateway Timeout', expectedRetryable: true },
    ];

    for (const testCase of errorCodes) {
      it(`classifies HTTP ${testCase.status} (${testCase.label}) correctly as retryable=${testCase.expectedRetryable}`, async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
          return new Response(
            JSON.stringify({
              statusCode: testCase.status,
              status: 'FAILED',
              description: `Error ${testCase.label} simulated for testing`,
            }),
            { status: testCase.status, headers: { 'content-type': 'application/json' } },
          );
        }) as typeof fetch;

        try {
          const provider = new AirtelProvider(baseConfig);
          const res = await provider.sendSms(sampleMessage);
          assert.equal(res.accepted, false);
          assert.equal(res.provider, 'airtel');
          assert.equal(res.retryable, testCase.expectedRetryable);
          assert.match(res.error ?? '', new RegExp(testCase.label, 'i'));
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  });
});
