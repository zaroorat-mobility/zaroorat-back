import type { ProviderClient } from '@core/database/index.js';

export type PolygonCoordinates = number[][][];

export function polygonGeoJson(coordinates: PolygonCoordinates): string {
  return JSON.stringify({ type: 'Polygon', coordinates });
}

export function pointGeoJson(lng: number, lat: number): string {
  return JSON.stringify({ type: 'Point', coordinates: [lng, lat] });
}

export async function assertValidPolygon(
  db: { client: ProviderClient },
  coordinates: PolygonCoordinates,
): Promise<void> {
  const geoJson = polygonGeoJson(coordinates);
  const rows = await db.client.$queryRaw<Array<{ valid: boolean }>>`
    SELECT ST_IsValid(ST_GeomFromGeoJSON(${geoJson})) AS valid
  `;
  if (!rows[0]?.valid) {
    throw new Error('Invalid polygon geometry');
  }
}

export async function assertZoneWithinCity(
  db: { client: ProviderClient },
  cityId: string,
  coordinates: PolygonCoordinates,
): Promise<void> {
  const geoJson = polygonGeoJson(coordinates);
  const rows = await db.client.$queryRaw<Array<{ contained: boolean }>>`
    SELECT ST_Contains(
      c.boundary::geometry,
      ST_GeomFromGeoJSON(${geoJson})
    ) AS contained
    FROM cities c
    WHERE c.id = ${cityId}::uuid
      AND c.boundary IS NOT NULL
    LIMIT 1
  `;
  if (rows.length > 0 && !rows[0]?.contained) {
    throw new Error('Zone boundary must be within the city boundary');
  }
}
