import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp } from './helpers/harness.js';
import { paymentConfig } from '../../src/config/payment/payment.config.js';

const SANCTIONED_PUBLIC: ReadonlyMap<string, string> = new Map([
  ['POST /api/v1/auth/otp/send', 'Pre-authentication: the caller has no token yet.'],
  ['POST /api/v1/auth/otp/verify', 'Pre-authentication: this is what mints the token.'],
  [
    'POST /api/v1/auth/token/refresh',
    'The access token is expired by definition; the refresh token is the credential.',
  ],
  [
    'POST /api/v1/auth/admin/login',
    'Pre-authentication: staff email & password is the credential. Rate limited by ' +
      'rateLimits.adminLogin, and unknown, non-staff and wrong credentials are all one ' +
      '401 INVALID_CREDENTIALS, so it does not enumerate staff accounts.',
  ],
  [
    'POST /api/v1/auth/admin/otp/send',
    'Pre-authentication: the caller has no token yet. Sends only to an existing staff ' +
      'account but answers identically either way, so it does not disclose who is staff.',
  ],
  [
    'POST /api/v1/auth/admin/otp/verify',
    'Pre-authentication: this is what mints the staff token. Never creates an account — ' +
      'a rider or customer number is refused with 401 INVALID_CREDENTIALS.',
  ],
  [
    'POST /api/v1/payments/webhooks/:gateway',
    'A payment gateway holds no bearer token. Authenticated by HMAC over the raw body.',
  ],
  ['GET /health', 'Load-balancer probe.'],
  ['GET /api/v1/health', 'Load-balancer probe (prefixed).'],
  ['GET /ready', 'Kubernetes readiness probe.'],
  ['GET /api/v1/ready', 'Kubernetes readiness probe (prefixed).'],
  ['GET /metrics', 'Prometheus scrape. Must be restricted to the monitoring network at ingress.'],
]);

function isDocsRoute(url: string): boolean {
  return url === '/docs' || url.startsWith('/docs/');
}

describe('production route graph (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });

  after(async () => {
    await app.close();
  });

  it('exposes exactly the sanctioned set of unauthenticated routes', async () => {
    const table = collectRoutes(app);
    assert.ok(table.length > 25, `expected the full route table, found ${table.length}`);

    const reachable: string[] = [];

    for (const { method, url } of table) {
      if (isDocsRoute(url)) continue;
      if (method === 'HEAD' || method === 'OPTIONS') continue;

      const response = await app.inject({
        method: method as 'GET',
        url: concreteUrl(url),
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
      });

      if (!isAuthGateRejection(response)) reachable.push(`${method} ${url}`);
    }

    const sanctioned = [...SANCTIONED_PUBLIC.keys()].sort();
    const actual = [...new Set(reachable)].sort();

    const unsanctioned = actual.filter((r) => !SANCTIONED_PUBLIC.has(r));
    assert.deepEqual(
      unsanctioned,
      [],
      'These routes are reachable without a token and are not on the sanctioned list. ' +
        'Either they need authentication, or the list needs a documented entry:\n  ' +
        unsanctioned.join('\n  '),
    );

    const missing = sanctioned.filter((r) => !actual.includes(r));
    assert.deepEqual(
      missing,
      [],
      'These routes are on the sanctioned public list but did not answer as public. ' +
        'A probe that stopped working hides a regression:\n  ' +
        missing.join('\n  '),
    );
  });

  it('protects every mounted business route', async () => {
    const table = collectRoutes(app);
    const business = table.filter(
      ({ url }) =>
        (url.startsWith('/api/v1/rides') ||
          url.startsWith('/api/v1/drivers') ||
          url.startsWith('/api/v1/payments') ||
          url.startsWith('/api/v1/users') ||
          url.startsWith('/api/v1/files')) &&
        !SANCTIONED_PUBLIC.has(`${url}`),
    );

    assert.ok(business.length > 20, `expected many business routes, found ${business.length}`);

    for (const { method, url } of business) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      const key = `${method} ${url}`;
      if (SANCTIONED_PUBLIC.has(key)) continue;

      const response = await app.inject({
        method: method as 'GET',
        url: concreteUrl(url),
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
      });

      assert.ok(isAuthGateRejection(response), `${key} must require authentication`);
    }
  });

  it('keeps the payment webhook public but signature-protected', async () => {
    const url = '/api/v1/payments/webhooks/stripe';
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'payment.succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'pi_unknown' } },
    });

    const unsigned = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    assert.ok(!isAuthGateRejection(unsigned), 'a gateway carries no bearer token');

    assert.equal(unsigned.json().error.code, 'WEBHOOK_SIGNATURE_INVALID');

    const badSignature = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', 'stripe-signature': 'deadbeef' },
      payload: body,
    });
    assert.equal(badSignature.json().error.code, 'WEBHOOK_SIGNATURE_INVALID');

    const signature = createHmac('sha256', paymentConfig.webhookSecret).update(body).digest('hex');
    const signed = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    });
    assert.equal(signed.statusCode, 200, signed.payload);
  });
});

function collectRoutes(app: FastifyInstance): { method: string; url: string }[] {
  const out: { method: string; url: string }[] = [];
  const prefixAtDepth: string[] = [];

  for (const raw of app.printRoutes({ commonPrefix: false }).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;

    // Tree glyphs are emitted in 4-character groups, one per level.
    const glyphs = /^[│├└─\s]*/.exec(line)?.[0] ?? '';
    const depth = Math.floor(glyphs.length / 4);
    const text = line.slice(glyphs.length);

    const match = /^(\S*)\s*(?:\(([^)]+)\))?$/.exec(text.trim());
    if (!match) continue;
    const [, segment, methods] = match;

    prefixAtDepth[depth] = (depth === 0 ? '' : (prefixAtDepth[depth - 1] ?? '')) + (segment ?? '');
    prefixAtDepth.length = depth + 1;

    if (!methods) continue;
    const url = prefixAtDepth[depth] ?? '';
    for (const method of methods.split(',')) {
      out.push({ method: method.trim(), url });
    }
  }
  return out;
}

/**
 * Whether a response is the deny-by-default gate turning the caller away.
 *
 * Keyed on the error **code**, not the status. A webhook with no signature also
 * answers 401 — but that is signature verification refusing, which is the
 * route's own credential check, not proof that the route requires a token.
 * Treating every 401 as "authenticated" would report the webhook as protected
 * by the gate and hide the day it actually stopped being public.
 */
function isAuthGateRejection(response: { statusCode: number; payload: string }): boolean {
  if (response.statusCode !== 401) return false;
  try {
    return (
      (JSON.parse(response.payload) as { error?: { code?: string } }).error?.code ===
      'TOKEN_INVALID'
    );
  } catch {
    return false;
  }
}

function concreteUrl(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, () => randomUUID());
}
