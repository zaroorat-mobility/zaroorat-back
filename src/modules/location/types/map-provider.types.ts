import type { Coordinate } from './geo.types.js';
import type {
  MapCapability,
  MapProviderAttribution,
  MapResultMeta,
} from './map-capabilities.types.js';
import type { MapProviderName } from '@modules/admin/system-settings/map/types/map-settings.types.js';

export interface RoutingResult {
  distanceMeters: number;
  durationSeconds: number;
  providerName: string;
  /** Encoded polyline from the provider, when available. */
  encodedPolyline?: string;
  /** Decoded route geometry from origin to destination. */
  path?: Coordinate[];
  meta?: MapResultMeta;
}

export interface SuggestedPlace {
  placeId: string;
  placeName: string;
  placeAddress: string;
  provider?: MapProviderName;
}

export interface AutocompleteResult {
  /// 'ok' = predictions found.
  /// 'no_results' = provider queried successfully, zero matches found.
  /// 'unavailable' = provider error or network failure.
  status: 'ok' | 'no_results' | 'unavailable';
  predictions: SuggestedPlace[];
  providerName: string;
  meta?: MapResultMeta;
}

export interface ReverseGeocodeResult {
  formattedAddress: string;
  city: string;
  state: string;
  pincode: string;
  providerName: string;
  meta?: MapResultMeta;
}

export interface ForwardGeocodeResult {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  city: string;
  state: string;
  pincode: string;
  providerName: string;
  meta?: MapResultMeta;
}

export interface PlaceDetailsResult {
  placeId: string;
  placeName: string;
  placeAddress: string;
  latitude: number;
  longitude: number;
  providerName: string;
  meta?: MapResultMeta;
}

export interface MatrixCell {
  distanceMeters: number;
  durationSeconds: number;
  status: 'OK' | 'ZERO_RESULTS' | 'UNAVAILABLE';
}

export interface MatrixResult {
  /// 'ok' = matrix computed successfully.
  /// 'no_drivers' = candidate list was empty (no drivers nearby).
  /// 'unavailable' = provider error or network failure.
  /// 'degraded' = coarse first-party estimate used instead of provider matrix.
  status: 'ok' | 'no_drivers' | 'unavailable' | 'degraded';
  cells: MatrixCell[][];
  providerName: string;
  meta?: MapResultMeta;
}

export interface MapProviderOptions {
  region?: string;
  language?: string;
  trafficMode?: 'default' | 'traffic_aware' | 'traffic_unaware';
  timeoutMs?: number;
}

/**
 * Unified interface for map routing, place search, and distance matrix providers.
 * Allows seamless switching between Ola Maps, Google Maps, Mappls, etc.
 */
export interface MapProvider {
  readonly providerName: MapProviderName;
  isConfigured(): boolean;
  supportedCapabilities(): readonly MapCapability[];
  autocomplete(
    input: string,
    location?: Coordinate,
    options?: MapProviderOptions,
  ): Promise<AutocompleteResult>;
  forwardGeocode?(address: string, options?: MapProviderOptions): Promise<ForwardGeocodeResult>;
  reverseGeocode(
    coordinate: Coordinate,
    options?: MapProviderOptions,
  ): Promise<ReverseGeocodeResult>;
  getPlaceDetails?(placeId: string, options?: MapProviderOptions): Promise<PlaceDetailsResult>;
  getDirections(
    origin: Coordinate,
    destination: Coordinate,
    options?: MapProviderOptions,
  ): Promise<RoutingResult>;
  getDistanceMatrix(
    origins: Coordinate[],
    destinations: Coordinate[],
    options?: MapProviderOptions,
  ): Promise<MatrixResult>;
  attribution(): MapProviderAttribution;
}

export { MapCapability, MapProviderAttribution, MapResultMeta };
