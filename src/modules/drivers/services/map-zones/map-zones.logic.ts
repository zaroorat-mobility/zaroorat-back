import { cellToBoundary, latLngToCell } from 'h3-js';
import { isWithinPeakWindow } from '@modules/pricing/utils/peak-window.js';
import {
  MAX_SURGE_MULTIPLIER,
  MIN_SURGE_MULTIPLIER,
} from '@modules/pricing/services/surge.service.js';

/// Pure rules behind the driver operations map — no database, no clock, so each
/// one is unit-tested on its own (tests/unit/drivers/map-zones.logic.test.ts).

export const MAP_LAYERS = ['demand', 'surge', 'restricted', 'service'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

/// A viewport wider than this is refused: a driver map never needs it, and it
/// would turn one request into a city-wide (or national) dump.
export const MAX_VIEWPORT_SPAN_DEGREES = 1.0;

/// Demand is what riders asked for in this window, not what pricing says.
export const DEMAND_WINDOW_MINUTES = 15;
/// A cell is shown only with at least this many requests from at least this many
/// *different* riders. Counting requests alone would let one rider who re-requests
/// three times outline their own pickup area; the map must never locate a rider.
export const DEMAND_MIN_RIDERS = 3;

export interface MapViewport {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: number[][][];
}

function isPosition(p: unknown): p is [number, number] {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number' &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Math.abs(p[0]) <= 180 &&
    Math.abs(p[1]) <= 90
  );
}

/// ST_AsGeoJSON output → a polygon the app can draw, or null if it is not one.
/// Rings must be closed with at least four positions; anything else is dropped
/// rather than drawn as a guess.
export function parsePolygonGeoJson(text: string | null | undefined): PolygonGeometry | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const geometry = parsed as { type?: unknown; coordinates?: unknown };
  if (geometry?.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) return null;
  const rings = geometry.coordinates as unknown[];
  if (rings.length === 0) return null;
  const clean: number[][][] = [];
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) return null;
    const first = ring[0] as number[];
    const last = ring[ring.length - 1] as number[];
    if (first[0] !== last[0] || first[1] !== last[1]) return null;
    clean.push(ring.map((p) => [(p as number[])[0]!, (p as number[])[1]!]));
  }
  return { type: 'Polygon', coordinates: clean };
}

export function demandSeverity(requests: number, availableDrivers: number): Severity {
  const ratio = requests / Math.max(availableDrivers, 1);
  if (ratio >= 3) return 'HIGH';
  if (ratio >= 1.5) return 'MEDIUM';
  return 'LOW';
}

export function surgeSeverity(multiplier: number): Severity {
  if (multiplier >= 1.75) return 'HIGH';
  if (multiplier >= 1.35) return 'MEDIUM';
  return 'LOW';
}

export interface DemandCell {
  cell: string;
  requests: number;
  availableDrivers: number;
  geometry: PolygonGeometry;
}

type Point = { latitude: number; longitude: number };

/// Buckets recent request pickups and available drivers into H3 cells. Only
/// cells with requests from at least `minRiders` different riders are returned;
/// supply alone is never a demand zone.
export function aggregateDemand(
  requestPoints: readonly (Point & { riderId: string })[],
  driverPoints: readonly Point[],
  resolution: number,
  minRiders: number = DEMAND_MIN_RIDERS,
): DemandCell[] {
  const requests = new Map<string, number>();
  const riders = new Map<string, Set<string>>();
  for (const p of requestPoints) {
    const cell = latLngToCell(p.latitude, p.longitude, resolution);
    requests.set(cell, (requests.get(cell) ?? 0) + 1);
    const seen = riders.get(cell) ?? new Set<string>();
    seen.add(p.riderId);
    riders.set(cell, seen);
  }
  const drivers = new Map<string, number>();
  for (const p of driverPoints) {
    const cell = latLngToCell(p.latitude, p.longitude, resolution);
    drivers.set(cell, (drivers.get(cell) ?? 0) + 1);
  }
  const cells: DemandCell[] = [];
  for (const [cell, count] of requests) {
    if ((riders.get(cell)?.size ?? 0) < minRiders) continue;
    cells.push({
      cell,
      requests: count,
      availableDrivers: drivers.get(cell) ?? 0,
      // GeoJSON order ([lng, lat]) and a closed ring.
      geometry: { type: 'Polygon', coordinates: [cellToBoundary(cell, true)] },
    });
  }
  return cells.sort((a, b) => b.requests - a.requests);
}

export interface SurgeWindowInput {
  vehicleTypeId: string | null;
  multiplier: number;
  isPeakHourOnly: boolean;
  peakHourStart: string | null;
  peakHourEnd: string | null;
  startsAt: Date;
  endsAt: Date | null;
}

export interface ZoneSurge {
  /// The multiplier a ride in your vehicle would get here now; null if no window applies to it.
  multiplier: number | null;
  /// Highest multiplier in force here for any vehicle type.
  maxMultiplier: number;
  /// Null when some window applies to every vehicle type.
  vehicleTypeIds: string[] | null;
  validFrom: Date;
  validTo: Date | null;
  peakHours: { start: string; end: string } | null;
}

function clampMultiplier(value: number): number {
  return Math.max(MIN_SURGE_MULTIPLIER, Math.min(MAX_SURGE_MULTIPLIER, value));
}

/// The same rule pricing applies (SurgeService): windows outside their peak
/// hours do not count, the highest multiplier wins, clamped to the platform
/// bounds. Returns null when nothing in this zone surges right now.
export function resolveZoneSurge(
  windows: readonly SurgeWindowInput[],
  driverVehicleTypeId: string | null,
  at: Date,
  timeZone: string,
): ZoneSurge | null {
  const inForce = windows.filter(
    (w) =>
      Number.isFinite(w.multiplier) &&
      w.startsAt <= at &&
      (w.endsAt === null || w.endsAt > at) &&
      isWithinPeakWindow(w, at, timeZone),
  );
  if (inForce.length === 0) return null;

  const applies = (w: SurgeWindowInput) =>
    w.vehicleTypeId === null || w.vehicleTypeId === driverVehicleTypeId;
  const best = (list: readonly SurgeWindowInput[]) =>
    list.reduce((top, w) => (w.multiplier > top.multiplier ? w : top));

  const top = best(inForce);
  const maxMultiplier = clampMultiplier(top.multiplier);
  if (maxMultiplier <= MIN_SURGE_MULTIPLIER) return null;

  const mine = driverVehicleTypeId === null ? [] : inForce.filter(applies);
  const myTop = mine.length > 0 ? best(mine) : null;
  const shown = myTop ?? top;
  const ids = inForce.some((w) => w.vehicleTypeId === null)
    ? null
    : [...new Set(inForce.map((w) => w.vehicleTypeId as string))];

  return {
    multiplier: myTop ? clampMultiplier(myTop.multiplier) : null,
    maxMultiplier,
    vehicleTypeIds: ids,
    validFrom: shown.startsAt,
    validTo: shown.endsAt,
    peakHours:
      shown.isPeakHourOnly && shown.peakHourStart && shown.peakHourEnd
        ? { start: shown.peakHourStart, end: shown.peakHourEnd }
        : null,
  };
}

/// Half the viewport diagonal in metres — the radius that covers it from its centre.
export function viewportRadiusMeters(v: MapViewport): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(v.minLat);
  const lat2 = toRad(v.maxLat);
  const dLat = lat2 - lat1;
  const dLng = toRad(v.maxLng - v.minLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function insideViewport(p: Point, v: MapViewport): boolean {
  return (
    p.latitude >= v.minLat &&
    p.latitude <= v.maxLat &&
    p.longitude >= v.minLng &&
    p.longitude <= v.maxLng
  );
}
