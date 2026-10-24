import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it, mock } from 'node:test';

import { GoogleMapsProvider } from '../../../src/modules/location/providers/google-maps.provider.js';
import { MapProviderService } from '../../../src/modules/location/business-services/map-provider.service.js';
import {
  MapProviderAuthError,
  RoutingProviderUnavailableError,
} from '../../../src/modules/location/errors/location.errors.js';
import { AdminMapSettingsService } from '../../../src/modules/admin/system-settings/map/services/admin-map-settings.service.js';
import { MAP_SETTING_KEYS } from '../../../src/modules/admin/system-settings/map/constants/map-settings.constants.js';

const SERVER_KEY = 'unit-test-server-key';
const PUNE = { latitude: 18.5308, longitude: 73.8475 };

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/// Replace `fetch` with one that answers every call with `status`/`body`.
function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: new URL(String(input)),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  return calls;
}

const ENV_KEYS = [
  'MAP_PROVIDER',
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_CLIENT_SDK_KEY',
  'MAPPLS_REST_API_KEY',
  'MAPPLS_CLIENT_ID',
  'MAPPLS_CLIENT_SECRET',
  'MAPPLS_CLIENT_SDK_KEY',
] as const;
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

describe('Google Places (New) autocomplete', () => {
  it('sends the key in a header, biases toward the rider and maps suggestions', async () => {
    const calls = stubFetch(200, {
      suggestions: [
        {
          placePrediction: {
            placeId: 'ChIJphoenix',
            text: { text: 'Phoenix Marketcity, Viman Nagar, Pune, Maharashtra, India' },
            structuredFormat: {
              mainText: { text: 'Phoenix Marketcity' },
              secondaryText: { text: 'Viman Nagar, Pune, Maharashtra, India' },
            },
          },
        },
      ],
    });
    const provider = new GoogleMapsProvider({ apiKey: SERVER_KEY });

    const result = await provider.autocomplete('phoenix', PUNE, { sessionToken: 'session-1' });

    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url.href, 'https://places.googleapis.com/v1/places:autocomplete');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['X-Goog-Api-Key'], SERVER_KEY);
    assert.ok(call.headers['X-Goog-FieldMask']?.includes('suggestions.placePrediction.placeId'));
    assert.equal(call.url.searchParams.has('key'), false, 'key must not be in the URL');
    assert.deepEqual(call.body?.['includedRegionCodes'], ['in']);
    assert.equal(call.body?.['sessionToken'], 'session-1');
    assert.deepEqual(call.body?.['locationBias'], {
      circle: { center: PUNE, radius: 50_000 },
    });

    assert.deepEqual(result, {
      status: 'ok',
      providerName: 'google',
      predictions: [
        {
          placeId: 'ChIJphoenix',
          placeName: 'Phoenix Marketcity',
          placeAddress: 'Viman Nagar, Pune, Maharashtra, India',
          provider: 'google',
        },
      ],
    });
  });

  it('reports no_results for an empty response', async () => {
    stubFetch(200, {});
    const provider = new GoogleMapsProvider({ apiKey: SERVER_KEY });

    const result = await provider.autocomplete('zzzzqqq', PUNE);

    assert.deepEqual(result, { status: 'no_results', predictions: [], providerName: 'google' });
  });

  it('reports unavailable on a rejected key without retrying it', async () => {
    const calls = stubFetch(403, { error: { status: 'PERMISSION_DENIED' } });
    const provider = new GoogleMapsProvider({ apiKey: SERVER_KEY });

    const result = await provider.autocomplete('pune station', PUNE);

    assert.equal(result.status, 'unavailable');
    assert.equal(calls.length, 1, 'a 403 is a credential problem; replaying it changes nothing');
  });

  it('reports unavailable after retrying a provider outage', async () => {
    const calls = stubFetch(503, 'backend error');
    const provider = new GoogleMapsProvider({ apiKey: SERVER_KEY });

    const result = await provider.autocomplete('pune station', PUNE);

    assert.equal(result.status, 'unavailable');
    assert.equal(calls.length, 3);
  });

  it('returns places outside Pune: the rider position biases, it does not fence', async () => {
    const calls = stubFetch(200, {
      suggestions: [
        {
          placePrediction: {
            placeId: 'ChIJcsmt',
            text: { text: 'Chhatrapati Shivaji Maharaj Terminus, Mumbai, Maharashtra, India' },
            structuredFormat: {
              mainText: { text: 'Chhatrapati Shivaji Maharaj Terminus' },
              secondaryText: { text: 'Mumbai, Maharashtra, India' },
            },
          },
        },
      ],
    });
    const provider = new GoogleMapsProvider({ apiKey: SERVER_KEY });

    const result = await provider.autocomplete('cst mumbai', PUNE);

    assert.equal(calls[0]?.body?.['locationRestriction'], undefined);
    assert.equal(result.status, 'ok');
    assert.equal(result.predictions[0]?.placeAddress, 'Mumbai, Maharashtra, India');
  });
});

describe('Google Places (New) place details', () => {
  it('asks for Essentials fields only and returns the coordinates', async () => {
    const calls = stubFetch(200, {
      id: 'ChIJphoenix',
      formattedAddress: 'Viman Nagar, Pune, Maharashtra 411014, India',
      location: { latitude: 18.5622, longitude: 73.9167 },
    });
    const provider = new GoogleMapsProvider({ apiKey: SERVER_KEY });

    const result = await provider.getPlaceDetails('ChIJphoenix', { sessionToken: 'session-1' });

    const call = calls[0]!;
    assert.equal(
      call.url.origin + call.url.pathname,
      'https://places.googleapis.com/v1/places/ChIJphoenix',
    );
    assert.equal(call.method, 'GET');
    assert.equal(call.url.searchParams.get('sessionToken'), 'session-1');
    assert.equal(call.url.searchParams.has('key'), false);
    assert.equal(call.headers['X-Goog-Api-Key'], SERVER_KEY);
    assert.equal(call.headers['X-Goog-FieldMask'], 'id,formattedAddress,location');
    assert.deepEqual(result, {
      placeId: 'ChIJphoenix',
      placeName: 'Viman Nagar',
      placeAddress: 'Viman Nagar, Pune, Maharashtra 411014, India',
      latitude: 18.5622,
      longitude: 73.9167,
      providerName: 'google',
    });
  });

  it('rejects a place with no coordinates rather than inventing them', async () => {
    stubFetch(200, { id: 'ChIJnowhere', formattedAddress: 'Somewhere' });
    const provider = new GoogleMapsProvider({ apiKey: SERVER_KEY });

    await assert.rejects(() => provider.getPlaceDetails('ChIJnowhere'), /missing coordinates/);
  });
});

describe('MapProviderService place search', () => {
  it('missing configuration: autocomplete is unavailable and details are 503, with no upstream call', async () => {
    const calls = stubFetch(200, {});
    const service = new MapProviderService({
      providersRegistry: { google: new GoogleMapsProvider({ apiKey: '' }) },
    });

    const search = await service.autocomplete('pune station', PUNE);
    await assert.rejects(
      () => service.getPlaceDetails('ChIJphoenix', 'google'),
      RoutingProviderUnavailableError,
    );

    assert.equal(search.status, 'unavailable');
    assert.equal(calls.length, 0);
  });

  it('passes the session token through to the provider', async () => {
    const calls = stubFetch(200, {});
    const service = new MapProviderService({
      primaryProvider: new GoogleMapsProvider({ apiKey: SERVER_KEY }),
    });

    await service.autocomplete('pune', PUNE, undefined, { sessionToken: 'session-9' });

    assert.equal(calls[0]?.body?.['sessionToken'], 'session-9');
  });

  it('classifies a rejected key on place details as MapProviderAuthError', async () => {
    stubFetch(403, { error: { status: 'PERMISSION_DENIED' } });
    const service = new MapProviderService({
      primaryProvider: new GoogleMapsProvider({ apiKey: SERVER_KEY }),
    });

    await assert.rejects(
      () => service.getPlaceDetails('ChIJphoenix', 'google'),
      MapProviderAuthError,
    );
  });
});

describe('Map client configuration never exposes the server key', () => {
  function serviceWith(settings: Record<string, string>): AdminMapSettingsService {
    const settingsMap = new Map(
      Object.entries(settings).map(([key, value]) => [key, { value, isSecret: false, version: 1 }]),
    );
    const systemSettingService = { getCategorySettings: async () => settingsMap };
    return new AdminMapSettingsService(
      systemSettingService as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  }

  it('/maps/config gives mobile clients no Google key or tile URL', async () => {
    const service = serviceWith({
      [MAP_SETTING_KEYS.PRIMARY_PROVIDER]: 'google',
      [MAP_SETTING_KEYS.GOOGLE_API_KEY]: SERVER_KEY,
      [MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY]: 'browser-key',
    });

    const config = await service.getPublicMapConfig();

    assert.equal(config.providers.google.enabled, true);
    assert.equal(config.providers.google.clientSdkKey, undefined);
    assert.equal(config.providers.google.tileUrl, undefined);
    const wire = JSON.stringify(config);
    assert.ok(!wire.includes(SERVER_KEY) && !wire.includes('browser-key'));
  });

  it('admin client-config refuses a "browser" key that is the server key', async () => {
    const reused = serviceWith({
      [MAP_SETTING_KEYS.PRIMARY_PROVIDER]: 'google',
      [MAP_SETTING_KEYS.GOOGLE_API_KEY]: SERVER_KEY,
      [MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY]: SERVER_KEY,
    });
    const separate = serviceWith({
      [MAP_SETTING_KEYS.PRIMARY_PROVIDER]: 'google',
      [MAP_SETTING_KEYS.GOOGLE_API_KEY]: SERVER_KEY,
      [MAP_SETTING_KEYS.GOOGLE_CLIENT_SDK_KEY]: 'browser-key',
    });

    const refused = await reused.getMapClientConfig();
    const served = await separate.getMapClientConfig();

    assert.ok(!JSON.stringify(refused).includes(SERVER_KEY));
    assert.equal(refused.providers.google.clientSdkKey, undefined);
    assert.equal(served.providers.google.clientSdkKey, 'browser-key');
  });
});
