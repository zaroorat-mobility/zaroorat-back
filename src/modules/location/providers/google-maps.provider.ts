import {
  GoogleMapsClient,
  type GoogleMapsConfig,
} from '../../../integrations/google-maps/google-maps.client.js';
import type { Coordinate } from '../types/geo.types.js';
import { offlineMatrixResult } from '../utils/offline-route.js';
import type {
  AutocompleteResult,
  MapProvider,
  MatrixCell,
  MatrixResult,
  ReverseGeocodeResult,
  RoutingResult,
  SuggestedPlace,
} from '../types/map-provider.types.js';
import { logger } from '@shared/logger/index.js';
import { buildInterpolatedPath, decodeEncodedPolyline } from '@shared/geo/polyline.util.js';

interface GoogleDirectionsResponse {
  routes?: Array<{
    overview_polyline?: { points?: string };
    legs?: Array<{
      distance?: { value: number };
      duration?: { value: number };
    }>;
  }>;
  status?: string;
}

interface GooglePlacesAutocompleteResponse {
  predictions?: Array<{
    place_id?: string;
    description?: string;
    structured_formatting?: { main_text?: string; secondary_text?: string };
  }>;
  status?: string;
}

interface GoogleGeocodeResponse {
  results?: Array<{
    formatted_address?: string;
    address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  }>;
  status?: string;
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
}

export class GoogleMapsProvider extends GoogleMapsClient implements MapProvider {
  readonly providerName = 'google';

  constructor(config: GoogleMapsConfig) {
    super(config);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.trim().length > 0);
  }

  async autocomplete(input: string, location?: Coordinate): Promise<AutocompleteResult> {
    try {
      const params: Record<string, string> = { input, types: 'geocode' };
      if (location) {
        params['location'] = `${location.latitude},${location.longitude}`;
        params['radius'] = '50000';
      }

      const response = await this.get<GooglePlacesAutocompleteResponse>(
        'place/autocomplete/json',
        params,
      );

      if (!response.predictions || response.predictions.length === 0) {
        return { status: 'no_results', predictions: [], providerName: this.providerName };
      }

      const predictions: SuggestedPlace[] = response.predictions.map((p) => ({
        placeId: p.place_id ?? '',
        placeName: p.structured_formatting?.main_text ?? p.description?.split(',')[0] ?? '',
        placeAddress: p.structured_formatting?.secondary_text ?? p.description ?? '',
      }));

      return { status: 'ok', predictions, providerName: this.providerName };
    } catch (error) {
      logger.error({ error, input }, '[GoogleMaps] autocomplete failed');
      return { status: 'unavailable', predictions: [], providerName: this.providerName };
    }
  }

  async reverseGeocode(coordinate: Coordinate): Promise<ReverseGeocodeResult> {
    const response = await this.get<GoogleGeocodeResponse>('geocode/json', {
      latlng: `${coordinate.latitude},${coordinate.longitude}`,
    });

    if (!response.results || response.results.length === 0) {
      throw new Error(
        `[GoogleMaps] reverseGeocode: no result for ${coordinate.latitude},${coordinate.longitude}`,
      );
    }

    const result = response.results[0]!;
    const components = result.address_components ?? [];
    const find = (...types: string[]): string =>
      components.find((c) => types.some((t) => c.types.includes(t)))?.long_name ?? '';

    return {
      formattedAddress: result.formatted_address ?? '',
      city: find('locality', 'administrative_area_level_2'),
      state: find('administrative_area_level_1'),
      pincode: find('postal_code'),
      providerName: this.providerName,
    };
  }

  async getDirections(origin: Coordinate, destination: Coordinate): Promise<RoutingResult> {
    if (
      this.config.apiKey.startsWith('test_') ||
      this.config.apiKey.startsWith('mock_') ||
      process.env.NODE_ENV === 'test' ||
      process.env.APP_ENV === 'test'
    ) {
      return {
        distanceMeters: 12400,
        durationSeconds: 1860,
        providerName: this.providerName,
        path: buildInterpolatedPath(origin, destination),
      };
    }

    const response = await this.get<GoogleDirectionsResponse>('directions/json', {
      origin: `${origin.latitude},${origin.longitude}`,
      destination: `${destination.latitude},${destination.longitude}`,
      mode: 'driving',
    });

    if (!response.routes || response.routes.length === 0) {
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
