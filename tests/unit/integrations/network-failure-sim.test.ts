import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AirtelProvider } from '../../../src/integrations/airtel/airtel.client.js';

describe('AirtelProvider — Network Failure & Transport Resilience (Phase 4)', () => {
  const baseConfig = {
    apiKey: 'test_airtel_api_key_12345',
    customerId: 'CUST_998877',
    senderId: 'ZAROOR',
    entityId: '1001992837465012938',
    timeoutMs: 50,
  };

  const sampleMessage = {
    to: '+919876543210',
    body: 'Your OTP code is 654321',
    templateId: '1107161234567890123',
    variables: { otp: '654321' },
  };

  it('handles transport timeout cleanly and flags retryable=true', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }) as typeof fetch;

    try {
      const provider = new AirtelProvider(baseConfig);
      const res = await provider.sendSms(sampleMessage);
      assert.equal(res.accepted, false);
      assert.equal(res.provider, 'airtel');
      assert.equal(res.retryable, true);
      assert.match(res.error ?? '', /timeout/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles ECONNREFUSED transport error cleanly as retryable=true', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
      throw err;
    }) as typeof fetch;

    try {
      const provider = new AirtelProvider(baseConfig);
      const res = await provider.sendSms(sampleMessage);
      assert.equal(res.accepted, false);
      assert.equal(res.retryable, true);
      assert.match(res.error ?? '', /ECONNREFUSED/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles ENOTFOUND (DNS resolution failure) cleanly as retryable=true', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error('getaddrinfo ENOTFOUND iqsms.airtel.in');
      throw err;
    }) as typeof fetch;

    try {
      const provider = new AirtelProvider(baseConfig);
      const res = await provider.sendSms(sampleMessage);
      assert.equal(res.accepted, false);
      assert.equal(res.retryable, true);
      assert.match(res.error ?? '', /ENOTFOUND/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles ECONNRESET (socket drop / reset) cleanly as retryable=true', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error('read ECONNRESET');
      throw err;
    }) as typeof fetch;

    try {
      const provider = new AirtelProvider(baseConfig);
      const res = await provider.sendSms(sampleMessage);
      assert.equal(res.accepted, false);
      assert.equal(res.retryable, true);
      assert.match(res.error ?? '', /ECONNRESET/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles TLS certificate error as retryable=true', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error('unable to verify the first certificate');
      throw err;
    }) as typeof fetch;

    try {
      const provider = new AirtelProvider(baseConfig);
      const res = await provider.sendSms(sampleMessage);
      assert.equal(res.accepted, false);
      assert.equal(res.retryable, true);
      assert.match(res.error ?? '', /certificate/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles empty response cleanly', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const provider = new AirtelProvider(baseConfig);
      const res = await provider.sendSms(sampleMessage);
      assert.equal(res.accepted, false);
      assert.equal(res.retryable, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles lost HTTP response scenario where Airtel accepted SMS but transport dropped', async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('read ECONNRESET after Airtel acceptance');
      }
      return new Response(
        JSON.stringify({ statusCode: 200, status: 'SUCCESS', requestId: 'REQ_RETRY_999' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const provider = new AirtelProvider(baseConfig);

      // First attempt drops response
      const firstRes = await provider.sendSms(sampleMessage);
      assert.equal(firstRes.accepted, false);
      assert.equal(firstRes.retryable, true);

      // Retry attempt succeeds
      const secondRes = await provider.sendSms(sampleMessage);
      assert.equal(secondRes.accepted, true);
      assert.equal(secondRes.providerRef, 'REQ_RETRY_999');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
