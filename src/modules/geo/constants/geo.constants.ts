export const EARTH_RADIUS_KM = 6371;
export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;
export const COORDINATE_DECIMALS = 7;
export const GeoRedisKeys = {
  driverPosition: (driverId: string): string => `geo:driver:${driverId}`,
  cellMembers: (h3Cell: string): string => `geo:cell:${h3Cell}`,
} as const;
