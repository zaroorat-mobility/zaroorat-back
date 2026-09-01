import { MapplsClient, type MapplsConfig } from '../../../integrations/mappls/mappls.client.js';
import type { Coordinate } from '../types/geo.types.js';
import { offlineMatrixResult, offlineRoutingResult } from '../utils/offline-route.js';
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

interface MapplsRouteResponse {
  routes?: Array<{ distance?: number; duration?: number }>;
}

interface MapplsGeocodeItem {
  eLoc?: string;
  mapplsPin?: string;
  placeName?: string;
  poi?: string;
  placeAddress?: string;
  formatted_address?: string;
}

interface MapplsGeocodeResponse {
  copResults?: MapplsGeocodeItem[];
  suggestedLocations?: MapplsGeocodeItem[];
}

interface MapplsRevGeocodeResponse {
  results?: Array<{
    formatted_address?: string;
    city?: string;
    state?: string;
    pincode?: string;
  }>;
}

export class MapplsProvider extends MapplsClient implements MapProvider {
  readonly providerName = 'mappls';

  constructor(config: MapplsConfig) {
    super(config);
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.clientId &&
      this.config.clientSecret &&
      this.config.clientId.trim().length > 0 &&
      this.config.clientSecret.trim().length > 0,
    );
  }

  async autocomplete(input: string, location?: Coordinate): Promise<AutocompleteResult> {
    try {
      let endpoint = `places/geocode?address=${encodeURIComponent(input)}`;
      if (location) {
        endpoint += `&location=${location.latitude},${location.longitude}`;
      }

      const response = await this.makeAuthenticatedRequest<MapplsGeocodeResponse>(endpoint);
      const items = response.copResults ?? response.suggestedLocations ?? [];

      if (items.length === 0) {
        return { status: 'no_results', predictions: [], providerName: this.providerName };
      }

      const predictions: SuggestedPlace[] = items.map((p) => ({
        placeId: p.eLoc ?? p.mapplsPin ?? '',
        placeName: p.placeName ?? p.poi ?? '',
        placeAddress: p.placeAddress ?? p.formatted_address ?? '',
      }));

      return { status: 'ok', predictions, providerName: this.providerName };
    } catch (error) {
      logger.error({ error, input }, '[Mappls] autocomplete failed');
      return { status: 'unavailable', predictions: [], providerName: this.providerName };
    }
  }

  async reverseGeocode(coordinate: Coordinate): Promise<ReverseGeocodeResult> {
    const endpoint = `rev_geocode?lat=${coordinate.latitude}&lng=${coordinate.longitude}`;
    const response = await this.makeAuthenticatedRequest<MapplsRevGeocodeResponse>(endpoint);

    if (!response.results || response.results.length === 0) {
      throw new Error(
        `[Mappls] reverseGeocode: no result for ${coordinate.latitude},${coordinate.longitude}`,
      );
    }

    const result = response.results[0]!;
    return {
      formattedAddress: result.formatted_address ?? '',
      city: result.city ?? '',
      state: result.state ?? '',
      pincode: result.pincode ?? '',
      providerName: this.providerName,
    };
  }

  async getDirections(origin: Coordinate, destination: Coordinate): Promise<RoutingResult> {
    const offline = offlineRoutingResult(origin, destination, this.providerName);
    if (offline) return offline;

    const coordinates = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const endpoint = `route_adv/driving/${coordinates}?steps=false&alternatives=false`;

    const response = await this.makeAuthenticatedRequest<MapplsRouteResponse>(endpoint);
    if (!response.routes || response.routes.length === 0) {
      throw new Error('[Mappls] getDirections: no route found');
    }

    const route = response.routes[0]!;
    if (route.distance === undefined || route.duration === undefined) {
      throw new Error('[Mappls] getDirections: route missing distance/duration');
    }

    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      providerName: this.providerName,
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

    // Mappls Distance Matrix uses directions or matrix endpoint:
    // Simple 1:1 or N:1 fallback using getDirections per origin
    try {
      const rows: MatrixCell[][] = [];
      for (const origin of origins) {
        const row: MatrixCell[] = [];
        for (const dest of destinations) {
          try {
            const route = await this.getDirections(origin, dest);
            row.push({
              distanceMeters: route.distanceMeters,
              durationSeconds: route.durationSeconds,
              status: 'OK',
            });
          } catch {
            row.push({ distanceMeters: 0, durationSeconds: 0, status: 'ZERO_RESULTS' });
          }
        }
        rows.push(row);
      }
      return { status: 'ok', cells: rows, providerName: this.providerName };
    } catch (error) {
      logger.error({ error }, '[Mappls] distanceMatrix failed');
      return { status: 'unavailable', cells: [], providerName: this.providerName };
    }
  }
}
