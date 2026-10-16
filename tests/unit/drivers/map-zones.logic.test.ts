import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { latLngToCell } from 'h3-js';

import {
  DEMAND_MIN_RIDERS,
  aggregateDemand,
  demandSeverity,
  insideViewport,
  parsePolygonGeoJson,
  resolveZoneSurge,
  surgeSeverity,
  viewportRadiusMeters,
  type SurgeWindowInput,
} from '../../../src/modules/drivers/services/map-zones/map-zones.logic.js';
import { mapZonesQuerySchema } from '../../../src/modules/drivers/schemas/map-zones.schemas.js';

const SQUARE = [
  [
    [77.59, 12.97],
    [77.6, 12.97],
    [77.6, 12.98],
    [77.59, 12.98],
    [77.59, 12.97],
  ],
];
const CENTRE = { latitude: 12.9716, longitude: 77.5946 };
const IST = 'Asia/Kolkata';
/// 10:00 IST.
const AT = new Date('2026-10-10T04:30:00Z');

function window(overrides: Partial<SurgeWindowInput> = {}): SurgeWindowInput {
  return {
    vehicleTypeId: null,
    multiplier: 1.5,
    isPeakHourOnly: false,
    peakHourStart: null,
    peakHourEnd: null,
    startsAt: new Date(AT.getTime() - 3_600_000),
    endsAt: null,
    ...overrides,
  };
}

describe('map zones — geometry', () => {
  it('accepts a closed polygon and keeps [lng, lat] order', () => {
    const geometry = parsePolygonGeoJson(JSON.stringify({ type: 'Polygon', coordinates: SQUARE }));
    assert.deepEqual(geometry, { type: 'Polygon', coordinates: SQUARE });
  });

  it('drops anything it cannot draw honestly', () => {
    const open = [SQUARE[0]!.slice(0, 4)];
    const tooShort = [
      [
        [77.59, 12.97],
        [77.6, 12.97],
        [77.59, 12.97],
      ],
    ];
    const outOfRange = [
      [
        [77.59, 12.97],
        [277, 12.97],
        [77.6, 12.98],
        [77.59, 12.97],
      ],
    ];
    const notNumbers = [
      [
        ['77.59', 12.97],
        [77.6, 12.97],
        [77.6, 12.98],
        ['77.59', 12.97],
      ],
    ];
    for (const coordinates of [open, tooShort, outOfRange, notNumbers, []]) {
      assert.equal(
        parsePolygonGeoJson(JSON.stringify({ type: 'Polygon', coordinates })),
        null,
        JSON.stringify(coordinates),
      );
    }
    assert.equal(
      parsePolygonGeoJson(JSON.stringify({ type: 'MultiPolygon', coordinates: [SQUARE] })),
      null,
    );
    assert.equal(parsePolygonGeoJson('{not json'), null);
    assert.equal(parsePolygonGeoJson(null), null);
  });
});

describe('map zones — demand', () => {
  const near = (i: number) => ({
    latitude: CENTRE.latitude + i * 1e-5,
    longitude: CENTRE.longitude,
  });
  const ask = (i: number, riderId = `rider-${i}`) => ({ ...near(i), riderId });

  it(`needs requests from at least ${DEMAND_MIN_RIDERS} different riders before a cell is shown`, () => {
    const two = [ask(0), ask(1)];
    assert.deepEqual(aggregateDemand(two, [], 8), []);
    const three = [ask(0), ask(1), ask(2)];
    const [cell] = aggregateDemand(three, [], 8);
    assert.equal(cell?.requests, 3);
    assert.equal(cell?.cell, latLngToCell(CENTRE.latitude, CENTRE.longitude, 8));
  });

  it('never shows one rider who requested several times — that would outline their pickup', () => {
    const sameRider = [ask(0, 'r'), ask(1, 'r'), ask(2, 'r'), ask(3, 'r')];
    assert.deepEqual(aggregateDemand(sameRider, [], 8), []);
    const twoRiders = [ask(0, 'a'), ask(1, 'a'), ask(2, 'b'), ask(3, 'b')];
    assert.deepEqual(aggregateDemand(twoRiders, [], 8), []);
    const [cell] = aggregateDemand([...twoRiders, ask(4, 'c')], [], 8);
    assert.equal(cell?.requests, 5, 'every request counts once the cell is anonymous');
  });

  it('counts free drivers in the same cell, and never makes a zone from supply alone', () => {
    const requests = [ask(0), ask(1), ask(2), ask(3)];
    const drivers = [near(4), { latitude: 13.2, longitude: 77.9 }];
    const cells = aggregateDemand(requests, drivers, 8);
    assert.equal(cells.length, 1);
    assert.equal(cells[0]?.availableDrivers, 1);
    assert.deepEqual(aggregateDemand([], drivers, 8), []);
  });

  it('returns a closed GeoJSON hexagon around the cell', () => {
    const [cell] = aggregateDemand([ask(0), ask(1), ask(2)], [], 8);
    const ring = cell!.geometry.coordinates[0]!;
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.ok(Math.abs(ring[0]![0]! - CENTRE.longitude) < 0.02, 'longitude first');
    assert.ok(Math.abs(ring[0]![1]! - CENTRE.latitude) < 0.02);
  });

  it('grades demand by requests per free driver, not by surge', () => {
    assert.equal(demandSeverity(3, 0), 'HIGH');
    assert.equal(demandSeverity(6, 2), 'HIGH');
    assert.equal(demandSeverity(3, 2), 'MEDIUM');
    assert.equal(demandSeverity(3, 3), 'LOW');
  });
});

describe('map zones — surge', () => {
  it('reports the multiplier in force, with its real validity', () => {
    const w = window({ multiplier: 1.6, endsAt: new Date(AT.getTime() + 3_600_000) });
    const surge = resolveZoneSurge([w], 'mini', AT, IST);
    assert.equal(surge?.multiplier, 1.6);
    assert.equal(surge?.maxMultiplier, 1.6);
    assert.equal(surge?.vehicleTypeIds, null, 'a window with no vehicle type applies to all');
    assert.equal(surge?.validFrom.getTime(), w.startsAt.getTime());
    assert.equal(surge?.validTo?.getTime(), w.endsAt!.getTime());
  });

  it('ignores expired, not-yet-started and out-of-peak windows', () => {
    const expired = window({ endsAt: AT });
    const future = window({ startsAt: new Date(AT.getTime() + 1) });
    const evening = window({ isPeakHourOnly: true, peakHourStart: '17:00', peakHourEnd: '20:00' });
    const unparseable = window({ isPeakHourOnly: true, peakHourStart: '8am', peakHourEnd: '10am' });
    assert.equal(resolveZoneSurge([expired, future, evening, unparseable], null, AT, IST), null);
    const morning = window({ isPeakHourOnly: true, peakHourStart: '08:00', peakHourEnd: '11:00' });
    assert.deepEqual(resolveZoneSurge([morning], null, AT, IST)?.peakHours, {
      start: '08:00',
      end: '11:00',
    });
  });

  it("shows another vehicle type's surge as not applying to you", () => {
    const autoOnly = window({ vehicleTypeId: 'auto', multiplier: 1.8 });
    const surge = resolveZoneSurge([autoOnly], 'mini', AT, IST);
    assert.equal(surge?.multiplier, null);
    assert.equal(surge?.maxMultiplier, 1.8);
    assert.deepEqual(surge?.vehicleTypeIds, ['auto']);
    assert.equal(resolveZoneSurge([autoOnly], 'auto', AT, IST)?.multiplier, 1.8);
  });

  it('takes the highest applicable window and clamps to the pricing bounds', () => {
    const surge = resolveZoneSurge(
      [window({ multiplier: 1.2 }), window({ vehicleTypeId: 'mini', multiplier: 9 })],
      'mini',
      AT,
      IST,
    );
    assert.equal(surge?.multiplier, 2);
    assert.equal(resolveZoneSurge([window({ multiplier: 1 })], null, AT, IST), null);
  });

  it('grades surge by multiplier', () => {
    assert.equal(surgeSeverity(1.2), 'LOW');
    assert.equal(surgeSeverity(1.4), 'MEDIUM');
    assert.equal(surgeSeverity(2), 'HIGH');
  });
});

describe('map zones — viewport', () => {
  const box = { minLat: 12.9, minLng: 77.5, maxLat: 13.0, maxLng: 77.7 };

  it('covers the box from its centre', () => {
    const r = viewportRadiusMeters(box);
    assert.ok(r > 11_000 && r < 13_000, String(r));
    assert.equal(insideViewport(CENTRE, box), true);
    assert.equal(insideViewport({ latitude: 13.1, longitude: 77.6 }, box), false);
  });

  it('parses a valid query, defaulting to every layer', () => {
    const q = mapZonesQuerySchema.parse({
      minLat: '12.9',
      minLng: '77.5',
      maxLat: '13.0',
      maxLng: '77.7',
    });
    assert.deepEqual(q.viewport, box);
    assert.deepEqual([...q.layers].sort(), ['demand', 'restricted', 'service', 'surge']);
    const only = mapZonesQuerySchema.parse({ ...box, layers: 'surge, restricted' });
    assert.deepEqual([...only.layers].sort(), ['restricted', 'surge']);
  });

  it('refuses inverted, oversized, non-numeric and unknown-layer queries', () => {
    const bad = [
      { ...box, minLat: 13.1 },
      { ...box, minLng: 77.8 },
      { ...box, maxLat: 14.5 },
      { ...box, maxLng: 'east' },
      { ...box, layers: 'surge,incentives' },
      { ...box, minLat: 95 },
    ];
    for (const query of bad) {
      assert.equal(mapZonesQuerySchema.safeParse(query).success, false, JSON.stringify(query));
    }
  });
});
