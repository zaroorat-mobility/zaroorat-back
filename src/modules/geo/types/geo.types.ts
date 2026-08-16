export interface Coordinate {
  latitude: number;
  longitude: number;
}
export type H3Cell = string;
export interface DriverPosition extends Coordinate {
  driverId: string;
  h3Cell: H3Cell;
  updatedAt: Date;
}
export interface NearbyDriver extends Coordinate {
  driverId: string;
  distanceMeters: number;
  recordedAt: Date;
}
export interface NearbySearch {
  origin: Coordinate;
  radiusMeters?: number;
  limit?: number;
}
export type NearbyDriversResult =
  | {
      outcome: 'ok';
      drivers: NearbyDriver[];
    }
  | {
      outcome: 'degraded';
      drivers: NearbyDriver[];
    }
  | {
      outcome: 'no-live-candidates';
    };
