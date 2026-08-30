import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { container } from '../../src/core/di.js';
import type { MapProviderService } from '../../src/modules/location/business-services/map-provider.service.js';
import { RoutingProviderUnavailableError } from '../../src/modules/location/errors/location.errors.js';

const ADMIN_PHONE = '+919876545066';
const ADMIN_EMAIL = 'single-provider-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('PHASE MAP-03 — strict single active map provider verification (integration)', () => {
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

  async function loginAdmin() {
    const seed = await loginAs(app, ADMIN_PHONE);
    await grantRole(seed.userId, 'system_admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email: ADMIN_EMAIL,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return { authorization: `Bearer ${loggedIn.json().accessToken}` };
  }

  // ─── 1. TEST ALL INDIVIDUAL PROVIDER SELECTIONS (PASS) ─────────────────────

  it('1.1 allows Ola only active', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: [],
        providers: { ola: { apiKey: 'test_ola_key_111' } },
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.equal(body.primaryProvider, 'ola');
    assert.equal(body.providers.ola.enabled, true);
    assert.equal(body.providers.google.enabled, false);
    assert.equal(body.providers.mappls.enabled, false);
  });

  it('1.2 allows Google only active', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'google',
        fallbackProviders: [],
        providers: { google: { apiKey: 'test_google_key_222' } },
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.equal(body.primaryProvider, 'google');
    assert.equal(body.providers.google.enabled, true);
    assert.equal(body.providers.ola.enabled, false);
    assert.equal(body.providers.mappls.enabled, false);
  });

  it('1.3 allows Mappls only active', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'mappls',
        fallbackProviders: [],
        providers: { mappls: { clientId: 'test_mappls_id', clientSecret: 'test_mappls_secret' } },
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.equal(body.primaryProvider, 'mappls');
    assert.equal(body.providers.mappls.enabled, true);
    assert.equal(body.providers.ola.enabled, false);
    assert.equal(body.providers.google.enabled, false);
  });

  // ─── 2. REJECT MULTIPLE ACTIVE PROVIDERS ──────────────────────────────────

  it('2.1 rejects multiple active providers (Ola + Google)', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: [],
        providers: {
          ola: { apiKey: 'test_ola_key' },
          google: { enabled: true, apiKey: 'test_google_key' }, // REJECT!
        },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.message.includes('Exactly ONE map provider'));
  });

  it('2.2 rejects non-empty fallback providers list', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: ['google'], // REJECT!
      },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.message.includes('fallback providers are prohibited'));
  });

  // ─── 3. REJECT ZERO ACTIVE PROVIDERS / INVALID PROVIDERS ──────────────────

  it('3.1 rejects disabling the active provider', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: [],
        providers: {
          ola: { enabled: false }, // REJECT!
        },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.message.includes('cannot be disabled'));
  });

  it('3.2 rejects invalid provider names', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'invalid_provider_name' as unknown as MapProviderName,
        fallbackProviders: [],
      },
    });

    assert.equal(res.statusCode, 400);
  });

  // ─── 4. FAILED SWITCH ROLLBACK ─────────────────────────────────────────────

  it('4.1 preserves existing active provider if target provider health check fails', async () => {
    const adminHeaders = await loginAdmin();

    // 1. Activate Ola
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: [],
        providers: { ola: { apiKey: 'test_ola_key' } },
      },
    });

    // 2. Try to switch to Google with missing key (health fails)
    const failedSwitch = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'google',
        fallbackProviders: [],
        providers: { google: { apiKey: 'invalid_failing_key' } }, // Explicitly failing key!
      },
    });

    assert.equal(failedSwitch.statusCode, 400);

    // 3. Verify Ola remains active in DB
    const currentSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
    });

    assert.equal(currentSettings.json().data.primaryProvider, 'ola');
  });

  // ─── 5. RUNTIME RESOLUTION & FAILURE CONTROLS ─────────────────────────────

  it('5.1 resolves exactly ONE active provider in MapProviderService and raises 503 on failure', async () => {
    const adminHeaders = await loginAdmin();
    const mapProviderService = container.resolve<MapProviderService>('mapProviderService');

    // 1. Set Google as active provider
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'google',
        fallbackProviders: [],
        providers: { google: { apiKey: 'test_google_key' } },
      },
    });

    // 2. Resolve active provider chain
    const chain = await mapProviderService.resolveProviderChain();
    assert.equal(chain.length, 1);
    assert.equal(chain[0]?.providerName, 'google');

    // 3. Test active provider failure handling (no automatic secondary call)
    const origin = { latitude: 28.6139, longitude: 77.209 };
    const destination = { latitude: 28.5355, longitude: 77.391 };

    const origGetDirections = mapProviderService.getDirections;
    try {
      let caughtError: unknown;
      mapProviderService.resolveProviderChain = async () => [
        {
          providerName: 'google',
          isConfigured: () => true,
          getDirections: async () => {
            throw new Error('Google 500 Error');
          },
          autocomplete: async () => ({
            status: 'unavailable',
            predictions: [],
            providerName: 'google',
          }),
          reverseGeocode: async () => {
            throw new Error('Google reverse geocode error');
          },
          getDistanceMatrix: async () => ({
            status: 'unavailable',
            cells: [],
            providerName: 'google',
          }),
        },
      ];

      try {
        await mapProviderService.getDirections(origin, destination);
      } catch (err) {
        caughtError = err;
      }

      assert.ok(caughtError instanceof RoutingProviderUnavailableError);
      assert.equal((caughtError as RoutingProviderUnavailableError).statusCode, 503);
    } finally {
      mapProviderService.getDirections = origGetDirections;
    }
  });
});
