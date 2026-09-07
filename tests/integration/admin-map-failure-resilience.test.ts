import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
} from '../../src/shared/crypto/encryption.util.js';
import { container } from '../../src/core/di.js';
import type { MapProviderService } from '../../src/modules/location/business-services/map-provider.service.js';
import type { SystemSettingService } from '../../src/modules/admin/system-settings/services/system-setting.service.js';
import type { SystemSettingsCache } from '../../src/modules/admin/system-settings/cache/system-settings.cache.js';
import { RoutingProviderUnavailableError } from '../../src/modules/location/errors/location.errors.js';

const ADMIN_PHONE = '+919876545088';
const ADMIN_EMAIL = 'map-resilience-admin@zaroorat.test';
const ADMIN_PASSWORD = 'Admin@12345';

describe('admin map configuration failure, fallback & resilience (integration)', () => {
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

  async function loginCustomer() {
    const seed = await loginAs(app, '+919876545988');
    return { authorization: `Bearer ${seed.accessToken}` };
  }

  // ─── 1. AUTHENTICATION & AUTHORIZATION EDGE CASES ─────────────────────────

  it('1.1 rejects unauthenticated, malformed, and unauthorized admin requests', async () => {
    // 1. Missing header
    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/admin/settings/maps' });
    assert.equal(noAuth.statusCode, 401);

    // 2. Malformed bearer
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
      headers: { authorization: 'Bearer invalid_token_string' },
    });
    assert.equal(malformed.statusCode, 401);

    // 3. Customer without admin permissions
    const customerHeaders = await loginCustomer();
    const forbiddenRead = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
      headers: customerHeaders,
    });
    assert.equal(forbiddenRead.statusCode, 403);

    const forbiddenWrite = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: customerHeaders,
      payload: {
        primaryProvider: 'google',

        providers: { google: { apiKey: 'test_google_key' } },
      },
    });
    assert.equal(forbiddenWrite.statusCode, 403);
  });

  // ─── 2. ENCRYPTION & DECRYPTION RESILIENCE ─────────────────────────────────

  it('2.1 handles AES-256-GCM encryption, decryption, and corrupted ciphertext safely', () => {
    const secret = 'ola_live_api_key_xyz_777';
    const encrypted = encryptSecret(secret);

    assert.ok(encrypted.startsWith('enc:'));
    assert.notEqual(encrypted, secret);

    // Valid decryption
    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, secret);

    // Masking check
    const masked = maskSecret(secret);
    assert.equal(masked, '********');
    assert.equal(maskSecret(null), '');

    // Corrupted ciphertext raises rather than returning ''. The empty string was
    // indistinguishable from "no credential stored", so a rotated ENCRYPTION_KEY
    // presented as every provider being unconfigured, and routing returned 503
    // with nothing anywhere naming the cause. Not crashing the application is
    // still required — SystemSettingService contains this per row (below).
    const corrupted = 'enc:invalidiv:invalidtag:invalidcipher';
    assert.throws(() => decryptSecret(corrupted), { name: 'SecretDecryptionError' });

    // Prefixed `enc:` but malformed is also a failure, not a passthrough:
    // returning it verbatim would hand the caller a ciphertext to use as a key.
    assert.throws(() => decryptSecret('enc:only:three'), { name: 'SecretDecryptionError' });

    // Plaintext fallback check (legacy unencrypted setting)
    assert.equal(decryptSecret('plaintext_key_123'), 'plaintext_key_123');
    assert.equal(decryptSecret(''), '');
    assert.equal(decryptSecret(null), '');
  });

  it('2.2 keeps a settings category readable when one stored secret will not decrypt', async () => {
    const systemSettingService = container.resolve<SystemSettingService>('systemSettingService');

    // A row that decrypts, and a row that cannot — the shape left behind by a
    // key rotation that only some values were re-encrypted under.
    await systemSettingService.setSetting({
      key: 'map.ola.api_key',
      value: 'readable_key_value',
      category: 'maps',
      isSecret: true,
    });
    const undecryptable = 'enc:invalidiv:invalidtag:invalidcipher';
    await db().client.systemSetting.upsert({
      where: { key: 'map.google.api_key' },
      update: { value: undecryptable, isSecret: true, category: 'maps' },
      create: {
        key: 'map.google.api_key',
        value: undecryptable,
        isSecret: true,
        category: 'maps',
      },
    });

    const settings = await systemSettingService.getCategorySettings('maps');

    // The bad row does not take the category down with it, and it reads as null
    // rather than as a usable empty credential.
    assert.equal(settings.get('map.ola.api_key')?.value, 'readable_key_value');
    assert.equal(settings.get('map.google.api_key')?.value, null);
  });

  // ─── 3. SECRET SECURITY & AUDIT LOG REDACTION ─────────────────────────────

  it('3.1 protects secrets from leaking in API responses and redacts in audit logs', async () => {
    const adminHeaders = await loginAdmin();

    const realSecretKey = 'super_secret_ola_api_key_abc_123';
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',

        providers: {
          ola: { apiKey: realSecretKey },
        },
      },
    });

    assert.equal(updateRes.statusCode, 200, updateRes.payload);

    // 1. Verify GET response does NOT expose plaintext secret
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
    });
    assert.equal(getRes.statusCode, 200);
    const bodyStr = JSON.stringify(getRes.json());
    assert.equal(bodyStr.includes(realSecretKey), false);
    // The read model omits the credential entirely rather than returning a masked
    // placeholder — `configured` is what the admin UI needs, and a field that is
    // never populated cannot leak. This asserted `apiKey === '********'` against an
    // older response shape that did carry the field.
    assert.equal(getRes.json().data.providers.ola.apiKey, undefined);
    assert.equal(getRes.json().data.providers.ola.configured, true);

    // 2. Verify Database Audit Log redacts secret value as '[REDACTED]'
    const auditLogs = await db().client.adminActivityLog.findMany({
      where: { entityType: 'SystemSetting' },
      include: { fieldChanges: true },
    });

    assert.ok(auditLogs.length > 0);
    for (const log of auditLogs) {
      for (const fc of log.fieldChanges) {
        // `assert.equal(fc.oldValue?.includes(...), false)` failed on a null
        // oldValue — the optional chain yields `undefined`, which is not `false`.
        // A field written for the first time has no previous value, so that is the
        // normal case, not a leak. What matters is that the secret is absent.
        assert.ok(!fc.oldValue?.includes(realSecretKey));
        assert.ok(!fc.newValue?.includes(realSecretKey));
        if (fc.fieldName.includes('api_key')) {
          assert.equal(fc.newValue, '[REDACTED]');
        }
      }
    }
  });

  // ─── 4. INPUT VALIDATION & INVALID CONFIGURATIONS ─────────────────────────

  it('4.1 rejects invalid provider configurations (disabled primary)', async () => {
    const adminHeaders = await loginAdmin();

    // Disabled primary provider
    const disabledPrimary = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        providers: {
          ola: { enabled: false, apiKey: 'test_ola_key' },
        },
      },
    });
    assert.equal(disabledPrimary.statusCode, 400);
  });

  // ─── 5. OPTIMISTIC CONCURRENCY CONTROL ────────────────────────────────────

  it('5.1 rejects update when expectedVersion does not match current version', async () => {
    const adminHeaders = await loginAdmin();

    // First update to set version = 2
    const firstUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',

        providers: { ola: { apiKey: 'test_ola_key' } },
      },
    });
    assert.equal(firstUpdate.statusCode, 200, firstUpdate.payload);

    // Concurrent Admin B tries to update using stale expectedVersion = 1
    const staleUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'google',

        expectedVersion: 1, // Stale version!
        providers: { google: { apiKey: 'test_google_key' } },
      },
    });

    assert.equal(staleUpdate.statusCode, 400);
    assert.ok(staleUpdate.json().error.message.includes('conflict'));
  });

  it('5.2 saves when category maxVersion matches even if individual keys differ', async () => {
    const adminHeaders = await loginAdmin();

    const firstUpdate = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        providers: { ola: { apiKey: 'test_ola_key', baseUrl: 'https://api.olamaps.io' } },
      },
    });
    assert.equal(firstUpdate.statusCode, 200, firstUpdate.payload);

    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
    });
    const categoryVersion = current.json().data.version as number;

    const olaBaseUrlRow = await db().client.systemSetting.findUnique({
      where: { key: 'map.ola.base_url' },
    });
    assert.ok(olaBaseUrlRow);
    assert.ok(
      olaBaseUrlRow.version <= categoryVersion,
      'individual keys may lag behind category maxVersion',
    );

    const saveRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        expectedVersion: categoryVersion,
        providers: { ola: { baseUrl: 'https://api.olamaps.io/v2' } },
      },
    });

    assert.equal(saveRes.statusCode, 200, saveRes.payload);
    assert.equal(saveRes.json().data.providers.ola.baseUrl, 'https://api.olamaps.io/v2');
  });

  // ─── 6. DYNAMIC RUNTIME SWITCHING & REDIS CACHE INVALIDATION ───────────────

  it('6.1 dynamically resolves active map provider across updates without server restart', async () => {
    const adminHeaders = await loginAdmin();
    const mapProviderService = container.resolve<MapProviderService>('mapProviderService');

    // 1. Initial State -> Ola Primary
    const initialRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',

        providers: { ola: { apiKey: 'test_ola_key_111' } },
      },
    });
    assert.equal(initialRes.statusCode, 200, initialRes.payload);

    let chain = await mapProviderService.resolveProviderChain();
    assert.ok(chain.length === 1);
    assert.equal(chain[0]?.providerName, 'ola');

    // 2. Switch Primary to Google (Zero Restart)
    const switchRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'google',

        providers: { google: { apiKey: 'test_google_key_222' } },
      },
    });
    assert.equal(switchRes.statusCode, 200, switchRes.payload);

    // Verify ProviderResolver immediately resolves Google as primary
    chain = await mapProviderService.resolveProviderChain();
    assert.ok(chain.length === 1);
    assert.equal(chain[0]?.providerName, 'google');
  });

  // ─── 7. MAP PROVIDER ROUTING FAILURE & FARE QUOTE PROTECTION ─────────────

  it('7.1 throws RoutingProviderUnavailableError (503) when active provider fails, avoiding inaccurate Haversine fare quotes', async () => {
    const mapProviderService = container.resolve<MapProviderService>('mapProviderService');

    const origin = { latitude: 28.6139, longitude: 77.209 };
    const destination = { latitude: 28.5355, longitude: 77.391 };

    const origGetDirections = mapProviderService.getDirections;

    try {
      let caughtError: unknown;
      try {
        mapProviderService.resolveProviderChain = async () => [
          {
            providerName: 'ola',
            isConfigured: () => true,
            supportedCapabilities: () => ['route'],
            attribution: () => ({ text: '© Ola Maps' }),
            getDirections: async () => {
              throw new Error('Ola 500 Internal Error');
            },
            autocomplete: async () => ({
              status: 'unavailable',
              predictions: [],
              providerName: 'ola',
            }),
            reverseGeocode: async () => {
              throw new Error('Ola reverse geocode error');
            },
            getDistanceMatrix: async () => ({
              status: 'unavailable',
              cells: [],
              providerName: 'ola',
            }),
          },
        ];

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

  // ─── 8. REDIS FAILURE RESILIENCE ──────────────────────────────────────────

  it('8.1 falls back smoothly to Database query when Redis cache is unavailable', async () => {
    const adminHeaders = await loginAdmin();
    const systemSettingService = container.resolve<SystemSettingService>('systemSettingService');
    const systemSettingsCache = container.resolve<SystemSettingsCache>('systemSettingsCache');

    // 1. Save DB configuration
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',

        providers: { ola: { apiKey: 'test_ola_key_888' } },
      },
    });
    assert.equal(updateRes.statusCode, 200, updateRes.payload);

    // 2. Clear Redis cache to simulate cache miss/Redis restart
    await systemSettingsCache.clearMapSettingsCache();

    // 3. Query category settings from DB directly
    const dbSettings = await systemSettingService.getCategorySettings('maps');
    assert.equal(dbSettings.get('map.primary_provider')?.value, 'ola');
  });
});
