import { haversineKm } from '@modules/location';
export function calculateHaversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  return Math.round(haversineKm(lat1, lng1, lat2, lng2) * 100) / 100;
}
