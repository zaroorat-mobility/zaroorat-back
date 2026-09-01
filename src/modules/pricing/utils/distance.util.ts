// Deep import, not the '@modules/location' barrel: the barrel pulls the whole
// location module — including MapProviderService — to reach one pure function,
// and that edge was half of an import cycle back through @core/di.
import { haversineKm } from '@modules/location/utils/coordinate.util.js';

export function calculateHaversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  return Math.round(haversineKm(lat1, lng1, lat2, lng2) * 100) / 100;
}
