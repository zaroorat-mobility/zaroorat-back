import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it, mock } from 'node:test';

import { GoogleMapsProvider } from '../../../src/modules/location/providers/google-maps.provider.js';
import { MapProviderService } from '../../../src/modules/location/business-services/map-provider.service.js';
import {
  MapProviderAuthError,
  MapProviderQuotaError,
  MapProviderTimeoutError,
  RoutingProviderUnavailableError,
} from '../../../src/modules/location/errors/location.errors.js';
import {
  autocompleteQuerySchema,
  placeDetailsParamsSchema,
  placeDetailsQuerySchema,
} from '../../../src/modules/location/schemas/maps-api.schemas.js';

const KEY = 'unit-test-server-key';
const CITIES = {
  bengaluru: { latitude: 12.9716, longitude: 77.5946 },
  srinagar: { latitude: 34.0837, longitude: 74.7973 },
  delhi: { latitude: 28.6139, longitude: 77.209 },
} as const;

interface Call {
  url: URL;
  body: Record<string, unknown> | null;
}

function stubFetch(respond: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: new URL(String(input)),
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return respond();
  });
  return calls;
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status });

const ENV_KEYS = ['MAP_PROVIDER', 'GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_BASE_URL'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
before(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
afterEach(() => mock.restoreAll());

/// The Google provider serves an offline route under APP_ENV/NODE_ENV=test;
/// these tests exercise the real response parsing, so they step outside it.
async function outsideTestEnv<T>(run: () => Promise<T>): Promise<T> {
  const appEnv = process.env.APP_ENV;
  const nodeEnv = process.env.NODE_ENV;
  process.env.APP_ENV = 'development';
  process.env.NODE_ENV = 'development';
  try {
    return await run();
  } finally {
    process.env.APP_ENV = appEnv;
    process.env.NODE_ENV = nodeEnv;
  }
}

describe('maps API schemas', () => {
  const uuid = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';

  it('autocomplete: accepts a UUID session token, rejects unsafe or oversized ones', () => {
    assert.equal(
      autocompleteQuerySchema.safeParse({ input: 'pune', sessionToken: uuid }).success,
      true,
    );
    assert.equal(autocompleteQuerySchema.safeParse({ input: 'pune' }).success, true);
    for (const bad of ['a/b', 'x'.repeat(37), '', 'tok en']) {
      assert.equal(
        autocompleteQuerySchema.safeParse({ input: 'pune', sessionToken: bad }).success,
        false,
        `sessionToken ${JSON.stringify(bad)} must be rejected`,
      );
    }
  });

  it('autocomplete: rejects empty and oversized input and out-of-range coordinates', () => {
    assert.equal(autocompleteQuerySchema.safeParse({ input: '' }).success, false);
    assert.equal(autocompleteQuerySchema.safeParse({ input: 'x'.repeat(201) }).success, false);
    assert.equal(
      autocompleteQuerySchema.safeParse({ input: 'pune', latitude: 91, longitude: 73 }).success,
      false,
    );
  });

  it('place details: accepts provider ids, rejects anything that could change the upstream path', () => {
    assert.equal(
      placeDetailsParamsSchema.safeParse({ provider: 'google', placeId: 'ChIJ-abc_123' }).success,
      true,
    );
    for (const bad of ['../places', 'a/b', 'a%2Fb', 'a?b=c', '', 'x'.repeat(257)]) {
      assert.equal(
        placeDetailsParamsSchema.safeParse({ provider: 'google', placeId: bad }).success,
        false,
        `placeId ${JSON.stringify(bad)} must be rejected`,
      );
    }
    assert.equal(
      placeDetailsParamsSchema.safeParse({ provider: 'nominatim', placeId: 'abc' }).success,
      false,
    );
    assert.equal(placeDetailsQuerySchema.safeParse({ sessionToken: uuid }).success, true);
    assert.equal(placeDetailsQuerySchema.safeParse({ sessionToken: 'a/b' }).success, false);
  });
});

describe('Places failures are classified, not swallowed into a 500', () => {
  const service = () =>
    new MapProviderService({ primaryProvider: new GoogleMapsProvider({ apiKey: KEY }) });

  it('quota (429): autocomplete reports unavailable without retrying; details is MapProviderQuotaError', async () => {
    const calls = stubFetch(json(429, { error: { status: 'RESOURCE_EXHAUSTED' } }));

    const search = await service().autocomplete('pune', CITIES.delhi);
    assert.equal(search.status, 'unavailable');
    assert.equal(calls.length, 1, '429 is not retried');

    await assert.rejects(() => service().getPlaceDetails('ChIJx', 'google'), MapProviderQuotaError);
  });

  it('timeout: autocomplete reports unavailable after retries; details is MapProviderTimeoutError', async () => {
    const calls = stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const search = await service().autocomplete('pune', CITIES.delhi);
    assert.equal(search.status, 'unavailable');
    assert.equal(calls.length, 3, 'a timeout is retried twice');

    await assert.rejects(
      () => service().getPlaceDetails('ChIJx', 'google'),
      MapProviderTimeoutError,
    );
  });

  it('rejected key (403) on details is MapProviderAuthError', async () => {
    stubFetch(json(403, { error: { status: 'PERMISSION_DENIED' } }));
    await assert.rejects(() => service().getPlaceDetails('ChIJx', 'google'), MapProviderAuthError);
  });
});

describe('search outside Pune: the rider position biases, nothing fences it', () => {
  for (const [city, center] of Object.entries(CITIES)) {
    it(`a rider in ${city} gets results biased to ${city}, returned unfiltered`, async () => {
      const calls = stubFetch(
        json(200, {
          suggestions: [
            {
              placePrediction: {
                placeId: `ChIJ${city}`,
                text: { text: `Central Station, ${city}, India` },
                structuredFormat: {
                  mainText: { text: 'Central Station' },
                  secondaryText: { text: `${city}, India` },
                },
              },
            },
          ],
        }),
      );

      const result = await new GoogleMapsProvider({ apiKey: KEY }).autocomplete(
        'central station',
        center,
      );

      assert.deepEqual(calls[0]?.body?.['locationBias'], { circle: { center, radius: 50_000 } });
      assert.equal(calls[0]?.body?.['locationRestriction'], undefined);
      assert.equal(result.status, 'ok');
      assert.equal(result.predictions[0]?.placeAddress, `${city}, India`);
    });
  }
});

describe('legacy Directions and Geocoding responses (still used for fares, ETA, reverse geocode)', () => {
  // Google's documented example polyline: (38.5,-120.2) → (40.7,-120.95) → (43.252,-126.453).
  const POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const ORIGIN = { latitude: 18.5308, longitude: 73.8475 };
  const DEST = { latitude: 18.5622, longitude: 73.9167 };

  it('a valid route returns distance, duration and the decoded polyline', async () => {
    const calls = stubFetch(
      json(200, {
        status: 'OK',
        routes: [
          {
            overview_polyline: { points: POLYLINE },
            legs: [{ distance: { value: 9100 }, duration: { value: 1260 } }],
          },
        ],
      }),
    );

    const route = await outsideTestEnv(() =>
      new GoogleMapsProvider({ apiKey: KEY }).getDirections(ORIGIN, DEST),
    );

    assert.equal(calls[0]?.url.pathname, '/maps/api/directions/json');
    assert.equal(calls[0]?.url.searchParams.get('mode'), 'driving');
    assert.equal(route.distanceMeters, 9100);
    assert.equal(route.durationSeconds, 1260);
    assert.equal(route.encodedPolyline, POLYLINE);
    assert.equal(route.path?.length, 3);
    assert.ok(Math.abs(route.path![0]!.latitude - 38.5) < 1e-5);
    assert.ok(Math.abs(route.path![2]!.longitude - -126.453) < 1e-5);
  });

  it('legacy REQUEST_DENIED arrives as HTTP 200 and surfaces as 503, not as an auth error', async () => {
    stubFetch(json(200, { status: 'REQUEST_DENIED', error_message: 'API key not authorized' }));
    const service = new MapProviderService({
      primaryProvider: new GoogleMapsProvider({ apiKey: KEY }),
    });

    await assert.rejects(
      () => outsideTestEnv(() => service.getDirections(ORIGIN, DEST)),
      (err: unknown) =>
        err instanceof RoutingProviderUnavailableError && !(err instanceof MapProviderAuthError),
    );
  });

  it('a valid reverse geocode returns address, city, state and pincode', async () => {
    const calls = stubFetch(
      json(200, {
        status: 'OK',
        results: [
          {
            formatted_address: 'FC Road, Shivajinagar, Pune, Maharashtra 411005, India',
            address_components: [
              { long_name: 'Pune', short_name: 'Pune', types: ['locality'] },
              {
                long_name: 'Maharashtra',
                short_name: 'MH',
                types: ['administrative_area_level_1'],
              },
              { long_name: '411005', short_name: '411005', types: ['postal_code'] },
            ],
          },
        ],
      }),
    );

    const result = await new GoogleMapsProvider({ apiKey: KEY }).reverseGeocode(ORIGIN);

    assert.equal(calls[0]?.url.pathname, '/maps/api/geocode/json');
    assert.equal(
      calls[0]?.url.searchParams.get('latlng'),
      `${ORIGIN.latitude},${ORIGIN.longitude}`,
    );
    assert.deepEqual(result, {
      formattedAddress: 'FC Road, Shivajinagar, Pune, Maharashtra 411005, India',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411005',
      providerName: 'google',
    });
  });

  it('reverse geocode with no result throws without putting coordinates in the message', async () => {
    stubFetch(json(200, { status: 'ZERO_RESULTS', results: [] }));

    await assert.rejects(
      () => new GoogleMapsProvider({ apiKey: KEY }).reverseGeocode(ORIGIN),
      (err: Error) => /no result/.test(err.message) && !err.message.includes('18.5308'),
    );
  });

  it('missing configuration: routing is a 503 and makes no upstream call', async () => {
    const calls = stubFetch(json(200, {}));
    const service = new MapProviderService({
      providersRegistry: { google: new GoogleMapsProvider({ apiKey: '' }) },
    });

    await assert.rejects(
      () => service.getDirections(ORIGIN, DEST),
      RoutingProviderUnavailableError,
    );
    await assert.rejects(() => service.reverseGeocode(ORIGIN), RoutingProviderUnavailableError);
    assert.equal(calls.length, 0);
  });
});
