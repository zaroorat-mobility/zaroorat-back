import {
  GoogleMapsClient,
  type GoogleMapsConfig,
} from '../../../integrations/google-maps/google-maps.client.js';
import type { Coordinate } from '../types/geo.types.js';
import { offlineMatrixResult, offlineRoutingResult } from '../utils/offline-route.js';
import type {
  AutocompleteResult,
  ForwardGeocodeResult,
  MapProvider,
  MapProviderAttribution,
  MapProviderOptions,
  MatrixCell,
  MatrixResult,
  PlaceDetailsResult,
  ReverseGeocodeResult,
  RoutingResult,
  SuggestedPlace,
} from '../types/map-provider.types.js';
import {
  DEFAULT_PROVIDER_CAPABILITIES,
  type MapCapability,
} from '../types/map-capabilities.types.js';
import { logger } from '@shared/logger/index.js';
import {
  buildInterpolatedPath,
  decodeEncodedPolyline,
  encodeCoordinatesToPolyline,
} from '@shared/geo/polyline.util.js';

interface GoogleDirectionsResponse {
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{
      distance?: { value: number };
      duration?: { value: number };
    }>;
  }>;
  status?: string;
  error_message?: string;
}

/// Places API (New) `places:autocomplete`.
interface PlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      distanceMeters?: number;
    };
  }>;
}

/// Places API (New) `places/{id}`, limited to the fields requested below.
interface PlacesDetailsResponse {
  id?: string;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

/// Zaroorat operates in India only.
const PLACES_REGION_CODES = ['in'];
/// The largest circular bias Places API (New) accepts.
const PLACES_BIAS_RADIUS_METERS = 50_000;

interface GoogleGeocodeResponse {
  results?: Array<{
    formatted_address?: string;
    types?: string[];
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  }>;
  /// Reverse geocoding with `extra_computations=ADDRESS_DESCRIPTORS` (GA in India).
  address_descriptor?: {
    landmarks?: Array<{
      display_name?: { text?: string };
      spatial_relationship?: string;
      straight_line_distance_meters?: number;
    }>;
    areas?: Array<{ display_name?: { text?: string } }>;
  };
  status?: string;
  error_message?: string;
}

/// A landmark further than this from the pin describes somewhere else.
const LANDMARK_MAX_METERS = 300;

/// "Opposite X" / "Near X": how Indian riders describe a pickup spot.
function landmarkPlaceName(
  descriptor: GoogleGeocodeResponse['address_descriptor'],
): string | undefined {
  const landmark = descriptor?.landmarks?.[0];
  const name = landmark?.display_name?.text?.trim();
  if (!name) return undefined;
  if ((landmark?.straight_line_distance_meters ?? 0) > LANDMARK_MAX_METERS) return undefined;
  switch (landmark?.spatial_relationship) {
    case 'WITHIN':
      return name;
    case 'ACROSS_THE_ROAD':
      return `Opposite ${name}`;
    case 'BEHIND':
      return `Behind ${name}`;
    default:
      return `Near ${name}`;
  }
}

interface GoogleMatrixResponse {
  rows?: Array<{
    elements?: Array<{
      distance?: { value: number };
      duration?: { value: number };
      status?: string;
    }>;
  }>;
  status?: string;
  error_message?: string;
}

export class GoogleMapsProvider extends GoogleMapsClient implements MapProvider {
  readonly providerName = 'google';

  constructor(config: GoogleMapsConfig) {
    super(config);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.trim().length > 0);
  }

  supportedCapabilities(): readonly MapCapability[] {
    return DEFAULT_PROVIDER_CAPABILITIES.google;
  }

  attribution(): MapProviderAttribution {
    return { text: '© Google' };
  }

  async forwardGeocode(address: string): Promise<ForwardGeocodeResult> {
    const response = await this.get<GoogleGeocodeResponse>('geocode/json', { address });
    if (response.status && response.status !== 'OK' && response.status !== 'ZERO_RESULTS') {
      const msg = response.error_message ? `: ${response.error_message}` : '';
      throw new Error(`[GoogleMaps] forwardGeocode failed (${response.status})${msg}`);
    }
    if (!response.results?.length) {
      throw new Error('[GoogleMaps] forwardGeocode: no result');
    }
    const result = response.results[0]!;
    const loc = result.geometry?.location;
    if (loc?.lat == null || loc?.lng == null) {
      throw new Error('[GoogleMaps] forwardGeocode: missing coordinates');
    }
    const components = result.address_components ?? [];
    const find = (...types: string[]): string =>
      components.find((c) => types.some((t) => c.types.includes(t)))?.long_name ?? '';
    return {
      formattedAddress: result.formatted_address ?? address,
      latitude: loc.lat,
      longitude: loc.lng,
      city: find('locality', 'administrative_area_level_2'),
      state: find('administrative_area_level_1'),
      pincode: find('postal_code'),
      providerName: this.providerName,
    };
  }

  /// Places API (New) autocomplete. Legacy Places can no longer be enabled on a
  /// new Google Cloud project, so this does not depend on it.
  ///
  /// The rider's position is a bias, not a fence: a place outside the service
  /// area still appears, and the quote rejects it with a reason the app shows
  /// (`DROP_OUTSIDE_SERVICE_AREA`) instead of the search silently missing it.
  async autocomplete(
    input: string,
    location?: Coordinate,
    options?: MapProviderOptions,
  ): Promise<AutocompleteResult> {
    try {
      const response = await this.places<PlacesAutocompleteResponse>('places:autocomplete', {
        method: 'POST',
        label: 'places:autocomplete',
        fieldMask:
          'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.distanceMeters',
        body: {
          input,
          includedRegionCodes: PLACES_REGION_CODES,
          languageCode: options?.language ?? 'en',
          ...(location
            ? {
                locationBias: {
                  circle: {
                    center: { latitude: location.latitude, longitude: location.longitude },
                    radius: PLACES_BIAS_RADIUS_METERS,
                  },
                },
                // Gives each suggestion a distance the app shows ("2.4 km").
                origin: { latitude: location.latitude, longitude: location.longitude },
              }
            : {}),
          ...(options?.sessionToken ? { sessionToken: options.sessionToken } : {}),
        },
      });

      const predictions: SuggestedPlace[] = (response.suggestions ?? []).flatMap((s) => {
        const p = s.placePrediction;
        if (!p?.placeId) return [];
        const full = p.text?.text ?? '';
        return [
          {
            placeId: p.placeId,
            placeName: p.structuredFormat?.mainText?.text ?? full.split(',')[0]?.trim() ?? '',
            placeAddress: p.structuredFormat?.secondaryText?.text ?? full,
            provider: this.providerName,
            ...(typeof p.distanceMeters === 'number' ? { distanceMeters: p.distanceMeters } : {}),
          },
        ];
      });

      if (predictions.length === 0) {
        return { status: 'no_results', predictions: [], providerName: this.providerName };
      }
      return { status: 'ok', predictions, providerName: this.providerName };
    } catch (error) {
      // The search text is not logged: it is what the rider typed.
      logger.error({ error }, '[GoogleMaps] autocomplete failed');
      return { status: 'unavailable', predictions: [], providerName: this.providerName };
    }
  }

  /// Coordinates for an autocomplete pick. Sending the autocomplete session
  /// token closes the session, so its keystrokes are billed with this call.
  ///
  /// Only Essentials fields are requested. `displayName` bills at a higher tier,
  /// and the app already has the name from the prediction, so `placeName` here
  /// is just the first line of the address.
  async getPlaceDetails(
    placeId: string,
    options?: MapProviderOptions,
  ): Promise<PlaceDetailsResult> {
    const response = await this.places<PlacesDetailsResponse>(
      `places/${encodeURIComponent(placeId)}`,
      {
        method: 'GET',
        label: 'places/{placeId}',
        fieldMask: 'id,formattedAddress,location',
        params: {
          languageCode: options?.language ?? 'en',
          ...(options?.sessionToken ? { sessionToken: options.sessionToken } : {}),
        },
      },
    );

    const latitude = response.location?.latitude;
    const longitude = response.location?.longitude;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      throw new Error('[GoogleMaps] place details: missing coordinates');
    }
    const address = response.formattedAddress ?? '';
    return {
      placeId: response.id ?? placeId,
      placeName: address.split(',')[0]?.trim() ?? '',
      placeAddress: address,
      latitude,
      longitude,
      providerName: this.providerName,
    };
  }

  async reverseGeocode(coordinate: Coordinate): Promise<ReverseGeocodeResult> {
    const response = await this.get<GoogleGeocodeResponse>('geocode/json', {
      latlng: `${coordinate.latitude},${coordinate.longitude}`,
      // Landmarks ("Near X") at no extra charge on the India Essentials SKU.
      extra_computations: 'ADDRESS_DESCRIPTORS',
    });

    if (response.status && response.status !== 'OK' && response.status !== 'ZERO_RESULTS') {
      const msg = response.error_message ? `: ${response.error_message}` : '';
      throw new Error(`[GoogleMaps] reverseGeocode failed (${response.status})${msg}`);
    }

    if (!response.results || response.results.length === 0) {
      // No coordinates in the message: it is logged, and it is a rider's position.
      throw new Error('[GoogleMaps] reverseGeocode: no result');
    }

    // A bare plus code ("8FQ7+RX Pune") means nothing to a rider; take the first real address.
    const result =
      response.results.find((r) => !r.types?.includes('plus_code')) ?? response.results[0]!;
    const components = result.address_components ?? [];
    const find = (...types: string[]): string =>
      components.find((c) => types.some((t) => c.types.includes(t)))?.long_name ?? '';
    const placeName = landmarkPlaceName(response.address_descriptor);
    const area = response.address_descriptor?.areas?.[0]?.display_name?.text?.trim();

    return {
      formattedAddress: result.formatted_address ?? '',
      ...(placeName ? { placeName } : {}),
      ...(area ? { area } : {}),
      city: find('locality', 'administrative_area_level_2'),
      state: find('administrative_area_level_1'),
      pincode: find('postal_code'),
      providerName: this.providerName,
    };
  }

  private async fetchOsrmRoute(
    origin: Coordinate,
    destination: Coordinate,
  ): Promise<RoutingResult | null> {
    const endpoints = [
      `https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=polyline`,
      `https://routing.openstreetmap.de/routed-car/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=polyline`,
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(timeoutId);

        if (!res.ok) continue;
        const json: any = await res.json();
        const route = json?.routes?.[0];
        if (route && typeof route.geometry === 'string' && route.geometry.trim()) {
          const encodedPolyline = route.geometry.trim();
          const path = decodeEncodedPolyline(encodedPolyline);
          if (path.length > 2) {
            return {
              distanceMeters: Math.round(route.distance ?? 0),
              durationSeconds: Math.round(route.duration ?? 0),
              providerName: 'osrm',
              encodedPolyline,
              path,
            };
          }
        }
      } catch {
        // try next endpoint
      }
    }
    return null;
  }

  async getDirections(origin: Coordinate, destination: Coordinate): Promise<RoutingResult> {
    // The offline stand-in is gated on the environment alone. When active,
    // attempt OSRM first to deliver genuine road geometry before synthetic fallback.
    const offline = offlineRoutingResult(origin, destination, this.providerName);
    if (offline) {
      const osrm = await this.fetchOsrmRoute(origin, destination);
      if (osrm) {
        return osrm;
      }
      const path = buildInterpolatedPath(origin, destination);
      return {
        ...offline,
        path,
        encodedPolyline: encodeCoordinatesToPolyline(path),
      };
    }

    try {
      const response = await this.get<GoogleDirectionsResponse>('directions/json', {
        origin: `${origin.latitude},${origin.longitude}`,
        destination: `${destination.latitude},${destination.longitude}`,
        mode: 'driving',
      });

      if (response.status && response.status !== 'OK') {
        const msg = response.error_message ? `: ${response.error_message}` : '';
        logger.warn(
          `[GoogleMaps] getDirections status: ${response.status}${msg}, attempting OSRM fallback`,
        );
        const osrm = await this.fetchOsrmRoute(origin, destination);
        if (osrm) return osrm;
        throw new Error(`[GoogleMaps] getDirections failed (${response.status})${msg}`);
      }

      if (!response.routes || response.routes.length === 0) {
        const osrm = await this.fetchOsrmRoute(origin, destination);
        if (osrm) return osrm;
        throw new Error('[GoogleMaps] getDirections: no route found');
      }

      const route = response.routes[0]!;
      const leg = route.legs?.[0];
      if (!leg?.distance?.value || !leg?.duration?.value) {
        throw new Error('[GoogleMaps] getDirections: route leg has no distance/duration');
      }

      const encodedPolyline = route.overview_polyline?.points;
      const path = encodedPolyline
        ? decodeEncodedPolyline(encodedPolyline)
        : buildInterpolatedPath(origin, destination);

      return {
        distanceMeters: leg.distance.value,
        durationSeconds: leg.duration.value,
        providerName: this.providerName,
        ...(encodedPolyline ? { encodedPolyline } : {}),
        path,
      };
    } catch (err) {
      const osrm = await this.fetchOsrmRoute(origin, destination);
      if (osrm) return osrm;
      throw err;
    }
  }

  async getDistanceMatrix(
    origins: Coordinate[],
    destinations: Coordinate[],
  ): Promise<MatrixResult> {
    if (origins.length === 0 || destinations.length === 0) {
      return { status: 'no_drivers', cells: [], providerName: this.providerName };
    }

    const offline = offlineMatrixResult(origins, destinations, this.providerName);
    if (offline) return offline;

    try {
      const response = await this.get<GoogleMatrixResponse>('distancematrix/json', {
        origins: origins.map((o) => `${o.latitude},${o.longitude}`).join('|'),
        destinations: destinations.map((d) => `${d.latitude},${d.longitude}`).join('|'),
        mode: 'driving',
      });

      if (response.status && response.status !== 'OK') {
        const msg = response.error_message ? `: ${response.error_message}` : '';
        throw new Error(`[GoogleMaps] getDistanceMatrix failed (${response.status})${msg}`);
      }

      if (!response.rows || response.rows.length === 0) {
        return { status: 'unavailable', cells: [], providerName: this.providerName };
      }

      const cells: MatrixCell[][] = response.rows.map((row) =>
        (row.elements ?? []).map((el) => ({
          distanceMeters: el.distance?.value ?? 0,
          durationSeconds: el.duration?.value ?? 0,
          status: el.status === 'OK' ? 'OK' : 'ZERO_RESULTS',
        })),
      );

      return { status: 'ok', cells, providerName: this.providerName };
    } catch (error) {
      logger.error({ error }, '[GoogleMaps] distancematrix failed');
      return { status: 'unavailable', cells: [], providerName: this.providerName };
    }
  }
}
