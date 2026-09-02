import type { Coordinate } from '@modules/location/types/geo.types.js';

/** Decode a Google-encoded polyline string into lat/lng coordinates. */
export function decodeEncodedPolyline(encoded: string): Coordinate[] {
  const coordinates: Coordinate[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    coordinates.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }

  return coordinates;
}

/** Interpolate a simple path between two points (used in tests / fallback). */
export function buildInterpolatedPath(
  origin: Coordinate,
  destination: Coordinate,
  segments = 8,
): Coordinate[] {
  const path: Coordinate[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    path.push({
      latitude: origin.latitude + (destination.latitude - origin.latitude) * t,
      longitude: origin.longitude + (destination.longitude - origin.longitude) * t,
    });
  }
  return path;
}

export function coordinatesToLatLngPath(
  coordinates: Coordinate[],
): Array<{ lat: number; lng: number }> {
  return coordinates.map((c) => ({ lat: c.latitude, lng: c.longitude }));
}
