import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState, type LoggedInUser } from './helpers/harness.js';
import { grantRole, makeDriver, makeVehicleType } from './helpers/fixtures.js';

const CUSTOMER = '+919876710001';
const DRIVER = '+919876710002';

const PICKUP = { pickupLat: 12.9716, pickupLng: 77.5946 };
const DROP = { dropLat: 12.9352, dropLng: 77.6245 };

describe('vehicle type catalog and multi-category quote (integration)', () => {
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

  // Awaited rather than returned raw: `inject` is overloaded, and handing it a
  // widened `payload` type makes TypeScript pick the chainable overload, whose
  // result has no `statusCode`.
  async function get(url: string, user: LoggedInUser) {
    return await app.inject({ method: 'GET', url, headers: user.authHeader });
  }

  async function post(url: string, user: LoggedInUser, payload: Record<string, unknown>) {
    return await app.inject({ method: 'POST', url, headers: user.authHeader, payload });
  }

  async function loginWithRole(phone: string, slug: string): Promise<LoggedInUser> {
    const seed = await loginAs(app, phone);
    await grantRole(seed.userId, slug);
    return loginAs(app, phone);
  }

  describe('GET /vehicle-types', () => {
    it('returns the seeded catalog with everything a picker needs', async () => {
      const customer = await loginAs(app, CUSTOMER);

      const response = await get('/api/v1/vehicle-types', customer);
      assert.equal(response.statusCode, 200, response.payload);

      const types = response.json().data as Record<string, unknown>[];
      assert.ok(types.length >= 3, `expected the seeded catalog, got ${types.length}`);

      const codes = types.map((type) => type.code);
      for (const expected of ['BIKE', 'AUTO', 'CAB_ECONOMY']) {
        assert.ok(codes.includes(expected), `catalog is missing ${expected}`);
      }

      const bike = types.find((type) => type.code === 'BIKE')!;
      assert.equal(typeof bike.id, 'string');
      assert.equal(bike.name, 'Bike');
      assert.equal(bike.icon, 'bike');
      assert.equal(bike.isActive, true);
      assert.equal(typeof bike.perKmRate, 'number', 'pricing must reach the client as a number');
    });

    it('orders the catalog by displayOrder so the picker is stable', async () => {
      const customer = await loginAs(app, CUSTOMER);

      const types = (await get('/api/v1/vehicle-types', customer)).json().data as {
        displayOrder: number;
      }[];
      const orders = types.map((type) => type.displayOrder);
      assert.deepEqual(
        orders,
        [...orders].sort((a, b) => a - b),
      );
    });

    it('never returns an inactive type', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await makeVehicleType({ isActive: false, code: 'RETIRED', name: 'Retired' });

      const codes = (
        (await get('/api/v1/vehicle-types', customer)).json().data as {
          code: string;
        }[]
      ).map((type) => type.code);
      assert.ok(!codes.includes('RETIRED'), 'a retired type must not be offered');
    });

    it('requires authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/vehicle-types' });
      assert.equal(response.statusCode, 401, response.payload);
    });
  });

  describe('POST /rides/quote', () => {
    it('prices every active category in one call', async () => {
      const customer = await loginAs(app, CUSTOMER);

      const response = await post('/api/v1/rides/quote', customer, { ...PICKUP, ...DROP });
      assert.equal(response.statusCode, 200, response.payload);

      const quote = response.json().data;
      assert.ok(quote.estimatedDistanceKm > 0);
      assert.ok(quote.estimatedDurationMin > 0);
      assert.equal(quote.currency, 'INR');
      assert.equal(quote.pickup.latitude, PICKUP.pickupLat);
      assert.equal(quote.drop.longitude, DROP.dropLng);

      const catalog = (await get('/api/v1/vehicle-types', customer)).json().data as {
        id: string;
      }[];
      assert.equal(
        quote.options.length,
        catalog.length,
        'every active category must be priced in one response',
      );

      for (const option of quote.options) {
        assert.ok(catalog.some((type) => type.id === option.vehicleTypeId));
        assert.ok(option.estimatedFare > 0);
        assert.ok(option.estimatedFare >= option.minimumFare);
        assert.equal(typeof option.displayName, 'string');
        assert.equal(typeof option.vehicleTypeCode, 'string');
      }
    });

    it('prices a bike below a premium cab for the same trip', async () => {
      const customer = await loginAs(app, CUSTOMER);

      const options = (await post('/api/v1/rides/quote', customer, { ...PICKUP, ...DROP })).json()
        .data.options as { vehicleTypeCode: string; estimatedFare: number }[];

      const bike = options.find((option) => option.vehicleTypeCode === 'BIKE')!;
      const premium = options.find((option) => option.vehicleTypeCode === 'CAB_PREMIUM')!;
      assert.ok(
        premium.estimatedFare > bike.estimatedFare,
        `premium (${premium.estimatedFare}) must cost more than bike (${bike.estimatedFare})`,
      );
    });

    it('narrows to one option when a vehicleTypeId is supplied', async () => {
      const customer = await loginAs(app, CUSTOMER);
      const catalog = (await get('/api/v1/vehicle-types', customer)).json().data as {
        id: string;
        code: string;
      }[];
      const auto = catalog.find((type) => type.code === 'AUTO')!;

      const quote = (
        await post('/api/v1/rides/quote', customer, {
          ...PICKUP,
          ...DROP,
          vehicleTypeId: auto.id,
        })
      ).json().data;

      assert.equal(quote.options.length, 1);
      assert.equal(quote.options[0].vehicleTypeId, auto.id);
    });

    it('excludes an inactive type from the multi-category quote', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await makeVehicleType({ isActive: false, code: 'RETIRED', name: 'Retired' });

      const options = (await post('/api/v1/rides/quote', customer, { ...PICKUP, ...DROP })).json()
        .data.options as { vehicleTypeCode: string }[];

      assert.ok(!options.some((option) => option.vehicleTypeCode === 'RETIRED'));
    });

    it('refuses an inactive type asked for by id', async () => {
      const customer = await loginAs(app, CUSTOMER);
      const retiredId = await makeVehicleType({ isActive: false, code: 'RETIRED' });

      const response = await post('/api/v1/rides/quote', customer, {
        ...PICKUP,
        ...DROP,
        vehicleTypeId: retiredId,
      });
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_TYPE_INACTIVE');
    });

    it('refuses a vehicle type that does not exist', async () => {
      const customer = await loginAs(app, CUSTOMER);

      const response = await post('/api/v1/rides/quote', customer, {
        ...PICKUP,
        ...DROP,
        vehicleTypeId: randomUUID(),
      });
      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_TYPE_NOT_FOUND');
    });

    it('still rejects invalid coordinates', async () => {
      const customer = await loginAs(app, CUSTOMER);

      const response = await post('/api/v1/rides/quote', customer, {
        pickupLat: 999,
        pickupLng: 77.5946,
        ...DROP,
      });
      assert.equal(response.statusCode, 400, response.payload);
    });
  });

  describe('the quoted id works end to end', () => {
    it('creates a ride request with an id taken straight from the catalog', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/profile',
        headers: customer.authHeader,
        payload: { firstName: 'Cat', lastName: 'Customer' },
      });

      const option = (await post('/api/v1/rides/quote', customer, { ...PICKUP, ...DROP })).json()
        .data.options[0] as { vehicleTypeId: string };

      const requested = await post('/api/v1/rides/requests', customer, {
        vehicleTypeId: option.vehicleTypeId,
        ...PICKUP,
        ...DROP,
      });
      assert.equal(requested.statusCode, 200, requested.payload);
      assert.equal(requested.json().data.vehicleTypeId, option.vehicleTypeId);
    });

    it('refuses a ride request against an inactive type', async () => {
      const customer = await loginAs(app, CUSTOMER);
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/profile',
        headers: customer.authHeader,
        payload: { firstName: 'Cat', lastName: 'Customer' },
      });
      const retiredId = await makeVehicleType({ isActive: false, code: 'RETIRED' });

      const response = await post('/api/v1/rides/requests', customer, {
        vehicleTypeId: retiredId,
        ...PICKUP,
        ...DROP,
      });
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_TYPE_INACTIVE');
      assert.equal(await db().client.rideRequest.count(), 0, 'nothing may be written');
    });
  });

  describe('claiming against the catalog', () => {
    async function onboardedDriver(): Promise<LoggedInUser> {
      const driver = await loginWithRole(DRIVER, 'driver');
      await makeDriver(driver.userId, { verified: true });
      return driver;
    }

    it('claims a vehicle with an id from the catalog', async () => {
      const driver = await onboardedDriver();
      const catalog = (await get('/api/v1/vehicle-types', driver)).json().data as { id: string }[];

      const response = await post('/api/v1/vehicles/me/claim', driver, {
        registrationNumber: 'KA05MM9999',
        vehicleTypeId: catalog[0]!.id,
      });
      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(response.json().data.vehicleTypeId, catalog[0]!.id);
      assert.equal(
        response.json().data.verificationStatus,
        'PENDING',
        'a freshly claimed vehicle has not been reviewed',
      );
    });

    it('refuses a claim against a type that does not exist', async () => {
      const driver = await onboardedDriver();

      const response = await post('/api/v1/vehicles/me/claim', driver, {
        registrationNumber: 'KA05MM9998',
        vehicleTypeId: randomUUID(),
      });
      assert.equal(response.statusCode, 404, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_TYPE_NOT_FOUND');
      assert.equal(await db().client.vehicle.count(), 0, 'nothing may be written');
    });

    it('refuses a claim against an inactive type', async () => {
      const driver = await onboardedDriver();
      const retiredId = await makeVehicleType({ isActive: false, code: 'RETIRED' });

      const response = await post('/api/v1/vehicles/me/claim', driver, {
        registrationNumber: 'KA05MM9997',
        vehicleTypeId: retiredId,
      });
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(response.json().error.code, 'VEHICLE_TYPE_INACTIVE');
      assert.equal(await db().client.vehicle.count(), 0);
    });
  });
});
