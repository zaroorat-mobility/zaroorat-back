import {
  OlaMapsClient,
  type OlaMapsConfig,
} from '../../../integrations/ola-maps/ola-maps.client.js';
import type { Coordinate } from '../types/geo.types.js';
import { offlineRoutingResult } from '../utils/offline-route.js';
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

// ─── Raw Ola Maps response shapes ─────────────────────────────────────────────

interface OlaAutocompletePrediction {
  place_id?: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
  description?: string;
  name?: string;
  formatted_address?: string;
}

interface OlaAutocompleteResponse {
  predictions?: OlaAutocompletePrediction[];
  status?: string;
}

interface OlaReverseGeocodeResult {
  formatted_address?: string;
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
}

interface OlaReverseGeocodeResponse {
  results?: OlaReverseGeocodeResult[];
  status?: string;
}

interface OlaRoute {
  legs?: Array<{
    distance?: { value: number };
    duration?: { value: number };
  }>;
}

interface OlaDirectionsResponse {
  routes?: OlaRoute[];
  status?: string;
}

interface OlaMatrixElement {
  distance?: { value: number };
  duration?: { value: number };
  status?: string;
}

interface OlaMatrixRow {
  elements?: OlaMatrixElement[];
}

interface OlaDistanceMatrixResponse {
  rows?: OlaMatrixRow[];
  status?: string;
}

/**
 * OlaMapsProvider — Gateway to Ola Maps API endpoints implementing MapProvider.
 */
export class OlaMapsProvider extends OlaMapsClient implements MapProvider {
  readonly providerName = 'ola';

  constructor(config: OlaMapsConfig) {
    super(config);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.trim().length > 0);
  }

  // ─── Address Search ─────────────────────────────────────────────────────────

  async autocomplete(input: string, location?: Coordinate): Promise<AutocompleteResult> {
    try {
      const params: Record<string, string> = { input };
      if (location) {
        params['location'] = `${location.latitude},${location.longitude}`;
      }

      const response = await this.get<OlaAutocompleteResponse>('places/v1/autocomplete', params);

      if (!response.predictions || response.predictions.length === 0) {
        return { status: 'no_results', predictions: [], providerName: this.providerName };
      }

      const predictions: SuggestedPlace[] = response.predictions.map((p) => ({
        placeId: p.place_id ?? '',
        placeName:
          p.structured_formatting?.main_text ?? p.name ?? p.description?.split(',')[0] ?? '',
        placeAddress:
          p.structured_formatting?.secondary_text ?? p.formatted_address ?? p.description ?? '',
      }));

      return { status: 'ok', predictions, providerName: this.providerName };
    } catch (error) {
      logger.error({ error, input }, '[OlaMaps] autocomplete failed');
      return { status: 'unavailable', predictions: [], providerName: this.providerName };
    }
  }

  // ─── Reverse Geocoding ───────────────────────────────────────────────────────

  async reverseGeocode(coordinate: Coordinate): Promise<ReverseGeocodeResult> {
    const response = await this.get<OlaReverseGeocodeResponse>('places/v1/reverse-geocode', {
      latlng: `${coordinate.latitude},${coordinate.longitude}`,
    });

    if (!response.results || response.results.length === 0) {
      throw new Error(
        `[OlaMaps] reverseGeocode: no result for ${coordinate.latitude},${coordinate.longitude}`,
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

  // ─── Directions (Distance + ETA) ─────────────────────────────────────────────

  async getDirections(origin: Coordinate, destination: Coordinate): Promise<RoutingResult> {
    const offline = offlineRoutingResult(origin, destination, this.providerName);
    if (offline) return offline;

    const response = await this.post<OlaDirectionsResponse>('routing/v1/directions', {
      origin: `${origin.latitude},${origin.longitude}`,
      destination: `${destination.latitude},${destination.longitude}`,
      alternatives: false,
      steps: false,
      overview: 'false',
    });

    if (!response.routes || response.routes.length === 0) {
      throw new Error('[OlaMaps] getDirections: no route found');
    }

    const leg = response.routes[0]?.legs?.[0];
    if (!leg?.distance?.value || !leg?.duration?.value) {
      throw new Error('[OlaMaps] getDirections: route leg has no distance/duration');
    }

    return {
      distanceMeters: leg.distance.value,
      durationSeconds: leg.duration.value,
      providerName: this.providerName,
    };
  }

  // ─── Distance Matrix (Driver ETA) ────────────────────────────────────────────

  async getDistanceMatrix(
    origins: Coordinate[],
    destinations: Coordinate[],
  ): Promise<MatrixResult> {
    if (origins.length === 0 || destinations.length === 0) {
      return { status: 'no_drivers', cells: [], providerName: this.providerName };
    }

    try {
      const response = await this.post<OlaDistanceMatrixResponse>('routing/v1/distanceMatrix', {
        origins: origins.map((o) => `${o.latitude},${o.longitude}`).join('|'),
        destinations: destinations.map((d) => `${d.latitude},${d.longitude}`).join('|'),
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
      logger.error({ error }, '[OlaMaps] distanceMatrix failed');
      return { status: 'unavailable', cells: [], providerName: this.providerName };
    }
  }
}
