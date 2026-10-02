import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

import {
  auditExternalAction,
  MissingAuditActorError,
  recordAdminAction,
  redactSensitive,
  safeErrorSummary,
  type AuditWriter,
} from '../../../src/modules/admin/audit/index.js';
import { resolveTrustProxy } from '../../../src/app/trust-proxy.js';

/// Values a provider error is known to echo back.
const PHONE = '+91 98111 77733';
const OTP = '739184';
const EMAIL = 'jane.doe@example.com';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
const API_KEY = 'mock_live_51HxAbCdEfGhIjKlMnOpQrStUv';
const NAME = 'Jane Doe';
const SECRETS = [
  /98111/,
  /77733/,
  new RegExp(OTP),
  /jane/i,
  /example\.com/,
  /eyJ/,
  /mock_live/,
  /Doe/,
];

function providerError(extra: Record<string, unknown> = {}) {
  return Object.assign(
    new Error(
      `Airtel rejected SMS to ${PHONE} for ${NAME} (${EMAIL}): otp=${OTP} ` +
        `Authorization: Bearer ${JWT} api_key=${API_KEY} at https://api.airtel.in/v1?key=${API_KEY}`,
    ),
    extra,
  );
}

function recordingWriter() {
  const rows: Array<Record<string, unknown>> = [];
  const writer = {
    adminActivityLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return data;
      },
    },
  } as unknown as AuditWriter;
  return { rows, writer };
}

describe('safeErrorSummary (V10)', () => {
  it('stores no part of the provider message — only a code and a fixed reason', () => {
    for (const err of [
      providerError(),
      providerError({ statusCode: 502 }),
      providerError({ status: 401 }),
      providerError({ code: 'SMS_PROVIDER_REJECTED' }),
      providerError({ code: 'not a code: ' + OTP }),
      `raw string error ${PHONE} ${OTP}`,
      { message: `${EMAIL} ${JWT}` },
      null,
    ]) {
      const text = JSON.stringify(safeErrorSummary(err));
      for (const secret of SECRETS) assert.doesNotMatch(text, secret, `${text} leaks ${secret}`);
    }
  });

  it('derives a stable code', () => {
    assert.deepEqual(safeErrorSummary(providerError({ statusCode: 502 })), {
      errorCode: 'HTTP_502',
      errorName: 'Error',
      reason: 'Upstream error (HTTP 502)',
    });
    assert.equal(
      safeErrorSummary(providerError({ status: 401 })).reason,
      'Request refused (HTTP 401)',
    );
    assert.equal(
      safeErrorSummary(providerError({ code: 'SMS_PROVIDER_REJECTED' })).errorCode,
      'SMS_PROVIDER_REJECTED',
    );
    // A `code` that is not code-shaped is never trusted as one.
    assert.equal(
      safeErrorSummary(providerError({ code: `otp ${OTP}` })).errorCode,
      'EXTERNAL_ERROR',
    );
    const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
    assert.equal(safeErrorSummary(timeout).errorCode, 'TIMEOUT');
    // A name that is not an identifier is dropped rather than stored.
    const named = Object.assign(new Error('x'), { name: `Bad ${OTP}` });
    assert.equal(safeErrorSummary(named).errorName, undefined);
  });

  it('auditExternalAction stores the summary, never the raw message, on FAILED', async () => {
    const { rows, writer } = recordingWriter();
    await assert.rejects(
      auditExternalAction(
        writer,
        { actorId: 'actor-1', action: 'CREATE', entityType: 'integration_test' },
        async () => {
          throw providerError({ statusCode: 503 });
        },
      ),
      /Airtel rejected/,
      'the caller still gets the original error',
    );
    assert.deepEqual(
      rows.map((r) => (r.metadata as { result?: string }).result),
      ['REQUESTED', 'FAILED'],
    );
    const text = JSON.stringify(rows);
    for (const secret of SECRETS) assert.doesNotMatch(text, secret);
    assert.match(text, /HTTP_503/);
  });
});

describe('redactSensitive (job browser failedReason)', () => {
  it('replaces every value-shaped run', () => {
    const text = redactSensitive(providerError().message);
    for (const secret of [/98111/, /77733/, new RegExp(OTP), /example\.com/, /eyJ/, /mock_live/]) {
      assert.doesNotMatch(text, secret, text);
    }
  });

  it('cannot catch a name — which is why audit rows never store the text at all', () => {
    assert.match(redactSensitive(providerError().message), /Jane Doe/);
    assert.doesNotMatch(JSON.stringify(safeErrorSummary(providerError())), /Jane|Doe/);
  });
});

describe('recordAdminAction fails closed without an actor (V9)', () => {
  it('throws before writing anything', async () => {
    const { rows, writer } = recordingWriter();
    for (const actorId of [undefined, '']) {
      await assert.rejects(
        recordAdminAction(writer, { actorId, action: 'UPDATE', entityType: 'feature_flag' }),
        MissingAuditActorError,
      );
    }
    assert.equal(rows.length, 0);
  });

  it('auditExternalAction never acts when its request row has no actor', async () => {
    const { rows, writer } = recordingWriter();
    let acted = false;
    await assert.rejects(
      auditExternalAction(writer, { action: 'DELETE', entityType: 'background_job' }, async () => {
        acted = true;
      }),
      MissingAuditActorError,
    );
    assert.equal(acted, false);
    assert.equal(rows.length, 0);
  });
});

describe('trust proxy (V5)', () => {
  it('parses the declared topology and refuses a malformed one', () => {
    assert.equal(resolveTrustProxy({}), false, 'nothing declared trusts nothing');
    assert.equal(resolveTrustProxy({ TRUSTED_PROXY_HOPS: '0' }), false);
    assert.equal(resolveTrustProxy({ TRUSTED_PROXY_HOPS: '2' }), 2);
    assert.deepEqual(resolveTrustProxy({ TRUSTED_PROXIES: ' 10.0.0.0/8, loopback ,::1 ' }), [
      '10.0.0.0/8',
      'loopback',
      '::1',
    ]);
    assert.deepEqual(
      resolveTrustProxy({ TRUSTED_PROXIES: '10.0.0.5', TRUSTED_PROXY_HOPS: '3' }),
      ['10.0.0.5'],
      'an explicit list wins over a hop count',
    );
    for (const bad of ['10.0.0.0/33', 'not-an-ip', '10.0.0.1/8/1', 'fe80::/129', '*']) {
      assert.throws(() => resolveTrustProxy({ TRUSTED_PROXIES: bad }), /invalid/, bad);
    }
    for (const bad of ['-1', '1.5', 'one']) {
      assert.throws(() => resolveTrustProxy({ TRUSTED_PROXY_HOPS: bad }), /non-negative/, bad);
    }
  });

  async function ipSeen(
    env: NodeJS.ProcessEnv,
    remoteAddress: string,
    forwardedFor?: string,
  ): Promise<string> {
    const app = Fastify({ trustProxy: resolveTrustProxy(env) });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      ...(forwardedFor ? { headers: { 'x-forwarded-for': forwardedFor } } : {}),
    });
    await app.close();
    return res.json().ip as string;
  }

  it('a direct client is its socket peer', async () => {
    assert.equal(await ipSeen({}, '203.0.113.7'), '203.0.113.7');
  });

  it('trusting nothing ignores a spoofed X-Forwarded-For', async () => {
    assert.equal(await ipSeen({}, '203.0.113.7', '198.51.100.1'), '203.0.113.7');
    assert.equal(
      await ipSeen({ TRUSTED_PROXY_HOPS: '0' }, '203.0.113.7', '198.51.100.1'),
      '203.0.113.7',
    );
  });

  it('one trusted hop takes the address that hop appended, not one the client wrote', async () => {
    // The client sent "X-Forwarded-For: 198.51.100.1"; the proxy appended the real peer.
    assert.equal(
      await ipSeen({ TRUSTED_PROXY_HOPS: '1' }, '10.0.0.5', '198.51.100.1, 203.0.113.7'),
      '203.0.113.7',
    );
    assert.equal(
      await ipSeen({ TRUSTED_PROXY_HOPS: '1' }, '10.0.0.5', '203.0.113.7'),
      '203.0.113.7',
    );
  });

  it('two hops walk back exactly two entries', async () => {
    assert.equal(
      await ipSeen({ TRUSTED_PROXY_HOPS: '2' }, '10.0.0.5', '198.51.100.1, 203.0.113.7, 10.0.0.9'),
      '203.0.113.7',
    );
  });

  it('a proxy list believes only listed peers', async () => {
    const env = { TRUSTED_PROXIES: '10.0.0.0/8' };
    assert.equal(await ipSeen(env, '10.0.0.5', '198.51.100.1, 203.0.113.7'), '203.0.113.7');
    // Through two listed proxies, the first untrusted address from the right is the client.
    assert.equal(
      await ipSeen(env, '10.0.0.5', '198.51.100.1, 203.0.113.7, 10.1.2.3'),
      '203.0.113.7',
    );
    // A peer outside the list is the client, whatever header it sends.
    assert.equal(await ipSeen(env, '192.0.2.44', '198.51.100.1'), '192.0.2.44');
  });
});
