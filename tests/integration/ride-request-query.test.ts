import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, loginAs, resetState } from './helpers/harness.js';
import { makeVehicleType, setRidePin } from './helpers/fixtures.js';

const TRIP = {
  pickupLat: 12.9716,
  pickupLng: 77.5946,
  dropLat: 12.9352,
  dropLng: 77.6245,
};

describe('customer ride request query (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  async function customerWithProfile(phone: string) {
    const user = await loginAs(app, phone);
    const named = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: user.authHeader,
      payload: { firstName: 'Cat', lastName: 'Customer' },
    });
    assert.equal(named.statusCode, 200, named.payload);
    await setRidePin(user.userId);
    return user;
  }

  it('rejects unauthenticated active request reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns the pending request after create and null after cancel', async () => {
    const customer = await customerWithProfile('+919876540101');
    const vehicleTypeId = await makeVehicleType();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: customer.authHeader,
      payload: { vehicleTypeId, ...TRIP, pickupAddress: 'MG Road', dropAddress: 'Koramangala' },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const requestId = created.json().data.id as string;

    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: customer.authHeader,
    });
    assert.equal(active.statusCode, 200, active.payload);
    assert.equal(active.json().data.id, requestId);
    assert.ok(['CREATED', 'SEARCHING'].includes(active.json().data.status));
    assert.equal(typeof active.json().data.pickupLat, 'number');

    const byId = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/requests/${requestId}`,
      headers: customer.authHeader,
    });
    assert.equal(byId.statusCode, 200, byId.payload);
    assert.equal(byId.json().data.id, requestId);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/rides/requests/${requestId}/cancel`,
      headers: customer.authHeader,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.payload);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: customer.authHeader,
    });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().data, null);

    const abandoned = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/requests/${requestId}`,
      headers: customer.authHeader,
    });
    assert.equal(abandoned.json().data.status, 'ABANDONED');
  });

  it('does not leak another customer request', async () => {
    const owner = await customerWithProfile('+919876540102');
    const other = await customerWithProfile('+919876540103');
    const vehicleTypeId = await makeVehicleType();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: owner.authHeader,
      payload: { vehicleTypeId, ...TRIP },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const requestId = created.json().data.id as string;

    const leaked = await app.inject({
      method: 'GET',
      url: `/api/v1/rides/requests/${requestId}`,
      headers: other.authHeader,
    });
    assert.equal(leaked.statusCode, 403);

    const otherActive = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: other.authHeader,
    });
    assert.equal(otherActive.json().data, null);
  });

  it('excludes scheduled-only requests from active search', async () => {
    const customer = await customerWithProfile('+919876540104');
    const vehicleTypeId = await makeVehicleType();
    const scheduledFor = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rides/requests',
      headers: customer.authHeader,
      payload: { vehicleTypeId, ...TRIP, scheduledFor },
    });
    assert.equal(created.statusCode, 200, created.payload);

    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/rides/requests/active',
      headers: customer.authHeader,
    });
    assert.equal(active.json().data, null);
  });
});
