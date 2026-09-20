import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { AirtelProvider } from '../../../src/integrations/airtel/airtel.client.js';

describe('AirtelProvider Exhaustive Failure & API Contract Matrix', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const config = {
    apiKey: 'test-api-key',
    customerId: 'test-cust-id',
    senderId: 'ZARORT',
    entityId: '100123456789',
    timeoutMs: 3000,
  };

  it('sends SMS successfully matching exact Airtel contract (endpoint, headers, payload)', async () => {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://iqsms.airtel.in/api/v1/send-prepaid-sms');
      assert.equal(options?.method, 'POST');

      const headers = options?.headers as Record<string, string>;
      assert.equal(headers['accept'], 'application/json');
      assert.equal(headers['content-type'], 'application/json');
      assert.equal(headers['Authorization'], 'test-api-key');
      assert.equal(headers['auth-key'], undefined);

      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body.destinationAddress, ['9876543210']);
      assert.equal(body.message, 'Zaroorat: 123456');
      assert.equal(body.sourceAddress, 'ZARORT');
      assert.equal(body.entityId, '100123456789');
      assert.equal(body.dltEntityId, undefined);
      assert.equal(body.metaData, undefined);
      assert.equal(body.messageType, 'TRANSACTIONAL');

      return new Response(
        JSON.stringify({ statusCode: 200, requestId: 'req-airtel-100', status: 'SUCCESS' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const provider = new AirtelProvider(config);
    const result = await provider.sendSms({
      to: '+919876543210',
      body: 'Zaroorat: 123456',
      templateId: 'tpl-1007123',
    });

    assert.equal(result.accepted, true);
    assert.equal(result.provider, 'airtel');
    assert.equal(result.providerRef, 'req-airtel-100');
  });

  it('normalizes +919876543210, 919876543210, and 9876543210 to 10 digits and rejects invalid formats', async () => {
    let capturedRecipient = '';
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      capturedRecipient = body.destinationAddress[0];
      return new Response(JSON.stringify({ statusCode: 200, requestId: 'req-norm-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = new AirtelProvider(config);

    // Test +91 prefix
    await provider.sendSms({ to: '+919876543210', body: 'Test' });
    assert.equal(capturedRecipient, '9876543210');

    // Test 91 prefix
    await provider.sendSms({ to: '919876543210', body: 'Test' });
    assert.equal(capturedRecipient, '9876543210');

    // Test 10 digits
    await provider.sendSms({ to: '9876543210', body: 'Test' });
    assert.equal(capturedRecipient, '9876543210');

    // Test invalid format
    const invalidRes = await provider.sendSms({ to: '12345', body: 'Test' });
    assert.equal(invalidRes.accepted, false);
    assert.equal(invalidRes.retryable, false);
    assert.match(invalidRes.error ?? '', /invalid recipient phone number format/i);
  });

  it('handles messageId fallback when requestId is absent in Airtel response', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ status: 'OK', messageId: 'msg-airtel-999' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = new AirtelProvider(config);
    const result = await provider.sendSms({
      to: '+919876543210',
      body: 'Zaroorat: 123456',
    });

    assert.equal(result.accepted, true);
    assert.equal(result.providerRef, 'msg-airtel-999');
  });

  // --- HTTP Error Status Matrix ---
  const retryableStatuses = [429, 500, 502, 503, 504];
  for (const status of retryableStatuses) {
    it(`classifies HTTP ${status} as retryable=true`, async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({ statusCode: status, description: `Server error ${status}` }),
          { status, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const provider = new AirtelProvider(config);
      const result = await provider.sendSms({
        to: '+919876543210',
        body: 'Zaroorat: 123456',
      });

      assert.equal(result.accepted, false);
      assert.equal(result.retryable, true);
      assert.equal(result.provider, 'airtel');
    });
  }

  const nonRetryableStatuses = [400, 401, 403, 404, 409, 422];
  for (const status of nonRetryableStatuses) {
    it(`classifies HTTP ${status} as retryable=false (terminal error)`, async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({ statusCode: status, description: `Client error ${status}` }),
          { status, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const provider = new AirtelProvider(config);
      const result = await provider.sendSms({
        to: '+919876543210',
        body: 'Zaroorat: 123456',
      });

      assert.equal(result.accepted, false);
      assert.equal(result.retryable, false);
      assert.equal(result.provider, 'airtel');
    });
  }

  // --- Network & Transport Edge Cases ---
  it('handles transport/network errors gracefully as retryable=true', async () => {
    globalThis.fetch = async () => {
      throw new Error('Connection reset by peer');
    };

    const provider = new AirtelProvider(config);
    const result = await provider.sendSms({
      to: '+919876543210',
      body: 'Zaroorat: 123456',
    });

    assert.equal(result.accepted, false);
    assert.equal(result.retryable, true);
  });

  it('handles malformed non-JSON response bodies cleanly', async () => {
    globalThis.fetch = async () => {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      });
    };

    const provider = new AirtelProvider(config);
    const result = await provider.sendSms({
      to: '+919876543210',
      body: 'Zaroorat: 123456',
    });

    assert.equal(result.accepted, false);
    assert.equal(result.retryable, true);
    assert.match(result.error ?? '', /HTTP 502/);
  });

  it('scrubs phone numbers and sensitive data from error logs', async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ description: 'Failed to deliver to 9876543210' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const provider = new AirtelProvider(config);
    const result = await provider.sendSms({
      to: '+919876543210',
      body: 'Zaroorat: 123456',
    });

    assert.equal(result.accepted, false);
    assert.ok(!result.error?.includes('9876543210'));
    assert.ok(result.error?.includes('[number]'));
  });
});
