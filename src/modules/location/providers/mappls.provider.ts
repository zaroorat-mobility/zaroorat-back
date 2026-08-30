import { MapplsClient, type MapplsConfig } from '../../../integrations/mappls/mappls.client.js';
import type { Coordinate } from '../types/geo.types.js';
export interface RoutingResult {
  distanceMeters: number;
  durationSeconds: number;
}
export interface SuggestedPlace {
  mapplsPin: string;
  placeName: string;
  placeAddress: string;
}
export interface ReverseGeocodeResult {
  formattedAddress: string;
  city: string;
  state: string;
  pincode: string;
}
/**
 * MapplsProvider integrates with Mappls (MapmyIndia) APIs for routing and geocoding.
 */
export class MapplsProvider extends MapplsClient {
  constructor(config: MapplsConfig) {
    super(config);
  }
  /**
   * Calculates the driving distance and ETA between two coordinates.
   */
  async getRoutingETA(source: Coordinate, destination: Coordinate): Promise<RoutingResult> {
    const coordinates = `${source.longitude},${source.latitude};${destination.longitude},${destination.latitude}`;
    // Mappls Advanced Routing API endpoint
    const endpoint = `route_adv/driving/${coordinates}?steps=false&alternatives=false`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await this.makeAuthenticatedRequest<any>(endpoint);
    if (!response.routes || response.routes.length === 0) {
      throw new Error('No route found between the provided coordinates');
    }
    const route = response.routes[0];
    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
    };
  }
  /**
   * Autosuggests places based on a search query.
   */
  async autosuggest(query: string, location?: Coordinate): Promise<SuggestedPlace[]> {
    let endpoint = `places/geocode?address=${encodeURIComponent(query)}`;
    if (location) {
      endpoint += `&location=${location.latitude},${location.longitude}`;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await this.makeAuthenticatedRequest<any>(endpoint);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (response.copResults ?? response.suggestedLocations ?? []).map((place: any) => ({
      mapplsPin: place.eLoc ?? place.mapplsPin,
      placeName: place.placeName ?? place.poi,
      placeAddress: place.placeAddress ?? place.formatted_address,
    }));
  }
  /**
   * Converts coordinates into a human-readable street address.
   */
  async reverseGeocode(coordinate: Coordinate): Promise<ReverseGeocodeResult> {
    const endpoint = `rev_geocode?lat=${coordinate.latitude}&lng=${coordinate.longitude}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await this.makeAuthenticatedRequest<any>(endpoint);
    if (!response.results || response.results.length === 0) {
      throw new Error('Could not find an address for these coordinates');
    }
    const result = response.results[0];
    return {
      formattedAddress: result.formatted_address,
      city: result.city,
      state: result.state,
      pincode: result.pincode,
    };
  }
}
