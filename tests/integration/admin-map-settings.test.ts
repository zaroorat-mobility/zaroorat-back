import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { decryptSecret, encryptSecret } from '../../src/shared/crypto/encryption.util.js';
import { container } from '../../src/core/di.js';
import type { MapProviderService } from '../../src/modules/location/business-services/map-provider.service.js';

const ADMIN_PHONE = '+919876545044';
const ADMIN_EMAIL = 'map-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin map provider configuration (integration)', () => {
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

  async function loginRegularCustomer() {
    const seed = await loginAs(app, '+919876545999');
    return { authorization: `Bearer ${seed.accessToken}` };
  }

  it('rejects unauthenticated and unauthorized requests', async () => {
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
    });
    assert.equal(unauth.statusCode, 401);

    const customerAuth = await loginRegularCustomer();
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
      headers: customerAuth,
    });
    assert.equal(forbidden.statusCode, 403);
  });

  it('retrieves map configuration without exposing secrets', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.ok(body.data);
    assert.equal(typeof body.data.primaryProvider, 'string');
    assert.equal(body.data.fallbackProviders, undefined);
    assert.ok(body.data.providers.ola);
    assert.ok(body.data.providers.google);
    assert.ok(body.data.providers.mappls);

    // Secrets must never appear in the payload (not even masked)
    assert.equal(body.data.providers.ola.apiKey, undefined);
    assert.equal(body.data.providers.google.apiKey, undefined);
    assert.equal(body.data.providers.mappls.clientId, undefined);
    assert.equal(body.data.providers.mappls.clientSecret, undefined);
    assert.equal(typeof body.data.providers.ola.configured, 'boolean');
  });

  it('encrypts secrets at rest in database and decrypts properly', () => {
    const rawSecret = 'my_super_secret_ola_api_key_12345';
    const encrypted = encryptSecret(rawSecret);
    assert.ok(encrypted.startsWith('enc:'));
    assert.notEqual(encrypted, rawSecret);

    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, rawSecret);
  });

  it('tests provider health via POST /settings/maps/test', async () => {
    const adminHeaders = await loginAdmin();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/settings/maps/test',
      headers: adminHeaders,
      payload: {
        providerName: 'ola',
        apiKey: 'test_ola_key',
      },
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.ok(body.data);
    assert.equal(body.data.providerName, 'ola');
    assert.equal(typeof body.data.ok, 'boolean');
    assert.equal(typeof body.data.responseTimeMs, 'number');
  });

  it('ignores legacy fallbackProviders field on update', async () => {
    const adminHeaders = await loginAdmin();
    const invalidRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: ['ola', 'google'],
        providers: { ola: { apiKey: 'test_ola_key' } },
      },
    });

    // Zod strips unknown keys — update succeeds; response has no fallbackProviders
    assert.equal(invalidRes.statusCode, 200, invalidRes.payload);
    assert.equal(invalidRes.json().data.fallbackProviders, undefined);
    assert.equal(invalidRes.json().data.primaryProvider, 'ola');
  });

  it('updates map configuration atomically, audits changes with redacted secrets, and invalidates Redis', async () => {
    const adminHeaders = await loginAdmin();

    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        providers: {
          ola: { apiKey: 'new_ola_key_999' },
        },
      },
    });

    assert.equal(updateRes.statusCode, 200, updateRes.payload);
    const updated = updateRes.json().data;
    assert.equal(updated.primaryProvider, 'ola');
    assert.equal(updated.fallbackProviders, undefined);
    assert.equal(updated.providers.ola.apiKey, undefined);
    assert.equal(updated.providers.ola.configured, true);

    // Check DB setting creation
    const dbPrimary = await db().client.systemSetting.findUnique({
      where: { key: 'map.primary_provider' },
    });
    assert.equal(dbPrimary?.value, 'ola');

    const dbOlaKey = await db().client.systemSetting.findUnique({
      where: { key: 'map.ola.api_key' },
    });
    assert.ok(dbOlaKey?.value?.startsWith('enc:')); // Encrypted in DB

    // Check audit logs
    const auditLogs = await db().client.adminActivityLog.findMany({
      where: { entityType: 'SystemSetting' },
      include: { fieldChanges: true },
    });

    assert.ok(auditLogs.length > 0);
    const secretChanges = auditLogs
      .flatMap((l) => l.fieldChanges)
      .filter((fc) => fc.fieldName.includes('api_key'));

    for (const change of secretChanges) {
      assert.equal(change.newValue, '[REDACTED]'); // Secret redacted in audit log!
    }

    // Dynamic resolution check
    const mapProviderService = container.resolve<MapProviderService>('mapProviderService');
    const dynamicChain = await mapProviderService.resolveProviderChain();
    assert.ok(dynamicChain.length === 1);
    assert.equal(dynamicChain[0]?.providerName, 'ola');
  });

  it('returns active provider tile key via GET /settings/maps/client-config', async () => {
    const adminHeaders = await loginAdmin();

    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        providers: { ola: { apiKey: 'test_ola_key_for_tiles' } },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps/client-config',
      headers: adminHeaders,
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.equal(body.primaryProvider, 'ola');
    assert.equal(body.providers.ola.enabled, true);
    assert.equal(body.providers.ola.apiKey, 'test_ola_key_for_tiles');
    assert.ok(body.providers.ola.tileUrl?.includes('/tiles/v1/styles/default-light-standard/'));
    assert.equal(body.providers.google.enabled, false);
    assert.equal(body.providers.google.apiKey, undefined);
    assert.equal(body.providers.mappls.enabled, false);
  });

  it('returns Mappls tile key from server REST credentials on client-config', async () => {
    const adminHeaders = await loginAdmin();

    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'mappls',
        providers: {
          mappls: {
            restApiKey: 'test_mappls_rest_tile_key',
            clientId: 'test_mappls_id',
            clientSecret: 'test_mappls_secret',
          },
        },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps/client-config',
      headers: adminHeaders,
    });

    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json().data;
    assert.equal(body.primaryProvider, 'mappls');
    assert.equal(body.providers.mappls.apiKey, 'test_mappls_rest_tile_key');
    assert.ok(body.providers.mappls.tileUrl?.includes('test_mappls_rest_tile_key'));
    assert.equal(body.providers.ola.enabled, false);
    assert.equal(body.providers.ola.apiKey, undefined);
  });
});
