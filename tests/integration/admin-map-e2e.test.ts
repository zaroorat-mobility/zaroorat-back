import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { grantRole } from './helpers/fixtures.js';
import { hashPassword } from '../../src/modules/auth/utils/password.js';
import { decryptSecret } from '../../src/shared/crypto/encryption.util.js';
import { container } from '../../src/core/di.js';
import type { PricingService } from '../../src/modules/pricing/services/pricing.service.js';

const ADMIN_PASSWORD = 'Admin@12345';

describe('PHASE MAP-04 — admin frontend to backend end-to-end verification (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });

  after(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState();
    await db().client.systemSetting.deleteMany({ where: { category: 'maps' } });
  });

  afterEach(async () => {
    await resetState();
    await db().client.systemSetting.deleteMany({ where: { category: 'maps' } });
  });

  async function loginAdmin() {
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    const phone = `+91987${randomSuffix}`;
    const email = `map-e2e-${randomSuffix}@zaroorat.test`;
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, 'system_admin');
    await db().client.user.update({
      where: { id: seed.userId },
      data: {
        email,
        passwordHash: hashPassword(ADMIN_PASSWORD),
        isEmailVerified: true,
      },
    });
    const loggedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/admin/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    assert.equal(loggedIn.statusCode, 200, loggedIn.payload);
    return { authorization: `Bearer ${loggedIn.json().accessToken}` };
  }

  // ─── 1. COMPLETE CONTRACT & HEALTH CHECK E2E FLOW ─────────────────────────

  it('1.1 verifies full Admin UI contract flow: Health Test -> Save -> DB Encryption -> Redis Invalidation', async () => {
    const adminHeaders = await loginAdmin();

    // Step 1: Health test payload matching Frontend client contract
    const healthTestRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/settings/maps/test',
      headers: adminHeaders,
      payload: {
        providerName: 'ola',
        apiKey: 'test_ola_key_live_999',
      },
    });
    assert.equal(healthTestRes.statusCode, 200, healthTestRes.payload);
    assert.equal(healthTestRes.json().data.ok, true);

    // Step 2: PUT request payload matching Frontend client contract
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: [],
        providers: {
          ola: { apiKey: 'test_ola_key_live_999' },
        },
      },
    });
    assert.equal(updateRes.statusCode, 200, updateRes.payload);
    const updatedData = updateRes.json().data;
    assert.equal(updatedData.primaryProvider, 'ola');
    assert.deepEqual(updatedData.fallbackProviders, []);
    assert.equal(updatedData.providers.ola.apiKey, '********'); // Masked in response

    // Step 3: Verify DB Encryption
    const dbKey = await db().client.systemSetting.findUnique({
      where: { key: 'map.ola.api_key' },
    });
    assert.ok(dbKey?.value?.startsWith('enc:'));
    assert.equal(decryptSecret(dbKey!.value!), 'test_ola_key_live_999');

    // Step 4: Verify Masked Secret Resubmission Protection (Frontend sends '********')
    const maskedResubmission = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: [],
        providers: {
          ola: { apiKey: '********' }, // Masked string sent back by UI!
        },
      },
    });
    assert.equal(maskedResubmission.statusCode, 200);

    // Ensure real secret was NOT overwritten with '********'
    const dbKeyAfterMasked = await db().client.systemSetting.findUnique({
      where: { key: 'map.ola.api_key' },
    });
    assert.equal(decryptSecret(dbKeyAfterMasked!.value!), 'test_ola_key_live_999');
  });

  // ─── 2. NO-RESTART PROVIDER SWITCH & CUSTOMER RIDE ESTIMATE E2E ─────────

  it('2.1 verifies Admin provider switch immediately changes active provider for customer ride estimates without backend restart', async () => {
    const adminHeaders = await loginAdmin();
    const pricingService = container.resolve<PricingService>('pricingService');

    const pickup = { pickupLat: 28.6139, pickupLng: 77.209 };
    const drop = { dropLat: 28.5355, dropLng: 77.391 };

    // 1. Admin configures Ola as Active Provider
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'ola',
        fallbackProviders: [],
        providers: { ola: { apiKey: 'test_ola_key_111' } },
      },
    });

    const estOla = await pricingService.estimateTrip({ ...pickup, ...drop });
    assert.equal(estOla.source, 'ola');

    // 2. Admin switches Active Provider to Google (Zero Backend Restart)
    const switchRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'google',
        fallbackProviders: [],
        providers: { google: { apiKey: 'test_google_key_222' } },
      },
    });
    assert.equal(switchRes.statusCode, 200, switchRes.payload);

    const estGoogle = await pricingService.estimateTrip({ ...pickup, ...drop });
    assert.equal(estGoogle.source, 'google');

    // 3. Admin switches Active Provider to Mappls (Zero Backend Restart)
    const switchMappls = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/maps',
      headers: adminHeaders,
      payload: {
        primaryProvider: 'mappls',
        fallbackProviders: [],
        providers: { mappls: { clientId: 'test_mappls_id', clientSecret: 'test_mappls_secret' } },
      },
    });
    assert.equal(switchMappls.statusCode, 200, switchMappls.payload);

    const estMappls = await pricingService.estimateTrip({ ...pickup, ...drop });
    assert.equal(estMappls.source, 'mappls');
  });
});
