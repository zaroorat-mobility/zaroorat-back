import type { Coordinate } from './geo.types.js';

export interface RoutingResult {
  distanceMeters: number;
  durationSeconds: number;
  providerName: string;
  /** Encoded polyline from the provider, when available. */
  encodedPolyline?: string;
  /** Decoded route geometry from origin to destination. */
  path?: Coordinate[];
}

export interface SuggestedPlace {
  placeId: string;
  placeName: string;
  placeAddress: string;
}

export interface AutocompleteResult {
  /// 'ok' = predictions found.
  /// 'no_results' = provider queried successfully, zero matches found.
  /// 'unavailable' = provider error or network failure.
  status: 'ok' | 'no_results' | 'unavailable';
  predictions: SuggestedPlace[];
  providerName: string;
}

export interface ReverseGeocodeResult {
  formattedAddress: string;
  city: string;
  state: string;
  pincode: string;
  providerName: string;
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
  status: 'ok' | 'no_drivers' | 'unavailable';
  cells: MatrixCell[][];
  providerName: string;
}

/**
 * Unified interface for map routing, place search, and distance matrix providers.
 * Allows seamless switching between Ola Maps, Google Maps, Mappls, etc.
 */
export interface MapProvider {
  readonly providerName: string;
  isConfigured(): boolean;
  autocomplete(input: string, location?: Coordinate): Promise<AutocompleteResult>;
  reverseGeocode(coordinate: Coordinate): Promise<ReverseGeocodeResult>;
  getDirections(origin: Coordinate, destination: Coordinate): Promise<RoutingResult>;
  getDistanceMatrix(origins: Coordinate[], destinations: Coordinate[]): Promise<MatrixResult>;
}
