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

/// FR-042. A containment assertion that cannot be evaluated fails.
///
/// The `AND c.boundary IS NOT NULL` filter used to make an unanswerable question
/// look like a satisfied one: a city with no boundary returned zero rows, the
/// `rows.length > 0` guard skipped the check, and the zone was created anywhere
/// on Earth. Every zone drawn against an unbounded city then resolved for pickups
/// it was never meant to cover, and the operator was told the boundary had been
/// verified.
export async function assertZoneWithinCity(
  db: { client: ProviderClient },
  cityId: string,
  coordinates: PolygonCoordinates,
): Promise<void> {
  const geoJson = polygonGeoJson(coordinates);
  const rows = await db.client.$queryRaw<Array<{ contained: boolean | null }>>`
    SELECT ST_Contains(
      c.boundary::geometry,
      ST_GeomFromGeoJSON(${geoJson})
    ) AS contained
    FROM cities c
    WHERE c.id = ${cityId}::uuid
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Cannot verify containment: city not found');
  }
  // `ST_Contains` is null when the city has no boundary, not false. Both mean the
  // same thing here: nothing was proved, so nothing is allowed.
  if (row.contained !== true) {
    throw new Error('Zone boundary must be within the city boundary');
  }
}
