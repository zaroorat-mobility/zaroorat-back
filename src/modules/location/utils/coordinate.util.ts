import {
  COORDINATE_DECIMALS,
  EARTH_RADIUS_KM,
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from '../constants/geo.constants.js';
import type { Coordinate } from '../types/geo.types.js';
export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
export function isValidLatitude(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= LATITUDE_MIN &&
    value <= LATITUDE_MAX
  );
}
export function isValidLongitude(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= LONGITUDE_MIN &&
    value <= LONGITUDE_MAX
  );
}
export function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  return isValidLatitude(latitude) && isValidLongitude(longitude);
}
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversineKm(lat1, lng1, lat2, lng2) * 1000;
}
export function normalizeCoordinate(coordinate: Coordinate): Coordinate {
  return {
    latitude: round(coordinate.latitude),
    longitude: round(coordinate.longitude),
  };
}
function round(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}
