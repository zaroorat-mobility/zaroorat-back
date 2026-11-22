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
  heading?: number | null;
  bearing?: number | null;
  vehicleTypeId?: string | null;
  vehicleTypeCode?: string | null;
}
export interface NearbySearch {
  origin: Coordinate;
  radiusMeters?: number;
  limit?: number;
  vehicleTypeId?: string;
  vehicleTypeCode?: string;
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
