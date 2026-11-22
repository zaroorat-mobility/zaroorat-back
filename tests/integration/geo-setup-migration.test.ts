import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import './helpers/load-test-env.js';
import { bootApp, db, resetState } from './helpers/harness.js';
import { ensureCityWithBoundary, ensureServiceZone } from './helpers/fixtures.js';

const BOUNDARY: number[][][] = [
  [
    [74.7, 34.0],
    [75.0, 34.0],
    [75.0, 34.2],
    [74.7, 34.2],
    [74.7, 34.0],
  ],
];

/// The statements the migration really runs, so this cannot drift from the file.
function backfillStatements(): string[] {
  const sql = fs.readFileSync(
    path.resolve('prisma/migrations/20261102090000_geo_setup_expand/migration.sql'),
    'utf8',
  );
  const block = sql.split('-- backfill:start')[1]?.split('-- backfill:end')[0];
  assert.ok(block, 'the migration marks its backfill');
  return block
    .split(';')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);
}

async function runBackfill() {
  for (const statement of backfillStatements()) {
    await db().client.$executeRawUnsafe(statement);
  }
}

const modeOf = async (code: string) =>
  (await db().client.city.findUniqueOrThrow({ where: { code } })).coverageMode;

describe('geographic setup migration (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterEach(async () => {
    await resetState();
  });

  it('keeps a city with an active service zone limited to its zones', async () => {
    await ensureCityWithBoundary('AAA', 'Zoned', BOUNDARY);
    await ensureServiceZone('AAA', 'AAA_SZ', 'Zone', BOUNDARY);
    await runBackfill();
    assert.equal(await modeOf('AAA'), 'ZONES_ONLY');
  });

  it('keeps a city with only an active airport zone limited, as it is today', async () => {
    await ensureCityWithBoundary('AAA', 'Airport only', BOUNDARY);
    const zoneId = await ensureServiceZone('AAA', 'AAA_AP', 'Airport', BOUNDARY);
    await db().client.serviceZone.update({ where: { id: zoneId }, data: { zoneType: 'AIRPORT' } });
    await runBackfill();
    assert.equal(await modeOf('AAA'), 'ZONES_ONLY');
  });

  it('leaves a city with no zones open to the whole city', async () => {
    await ensureCityWithBoundary('AAA', 'No zones', BOUNDARY);
    await runBackfill();
    assert.equal(await modeOf('AAA'), 'WHOLE_CITY');
  });

  it('leaves a city open when its only zone is inactive or restricted', async () => {
    await ensureCityWithBoundary('AAA', 'Inactive', BOUNDARY);
    const inactive = await ensureServiceZone('AAA', 'AAA_OLD', 'Old', BOUNDARY);
    await db().client.serviceZone.update({ where: { id: inactive }, data: { isActive: false } });

    await ensureCityWithBoundary('BBB', 'Restricted', BOUNDARY);
    const restricted = await ensureServiceZone('BBB', 'BBB_RZ', 'No go', BOUNDARY);
    await db().client.serviceZone.update({
      where: { id: restricted },
      data: { zoneType: 'RESTRICTED' },
    });

    await runBackfill();
    assert.equal(await modeOf('AAA'), 'WHOLE_CITY');
    assert.equal(await modeOf('BBB'), 'WHOLE_CITY');
  });

  it('carries a window with one vehicle into the new list, and leaves all-vehicle windows empty', async () => {
    const cab = await db().client.vehicleType.findUniqueOrThrow({ where: { code: 'CAB_ECONOMY_NON_AC' } });
    const zoneId = await (async () => {
      await ensureCityWithBoundary('AAA', 'Zoned', BOUNDARY);
      return ensureServiceZone('AAA', 'AAA_SZ', 'Zone', BOUNDARY);
    })();
    const one = await db().client.surgeWindow.create({
      data: {
        serviceZoneId: zoneId,
        vehicleTypeId: cab.id,
        multiplier: 1.5,
        startsAt: new Date(),
        source: 'DYNAMIC',
      },
    });
    const all = await db().client.surgeWindow.create({
      data: { serviceZoneId: zoneId, multiplier: 1.2, startsAt: new Date() },
    });

    await runBackfill();

    const oneAfter = await db().client.surgeWindow.findUniqueOrThrow({ where: { id: one.id } });
    const allAfter = await db().client.surgeWindow.findUniqueOrThrow({ where: { id: all.id } });
    assert.deepEqual(oneAfter.vehicleTypeIds, [cab.id]);
    assert.deepEqual(allAfter.vehicleTypeIds, []);
    assert.equal(oneAfter.source, 'MANUAL', 'nothing computes surge from demand');
  });

  it('gives new rows safe defaults', async () => {
    await ensureCityWithBoundary('AAA', 'New', BOUNDARY);
    const city = await db().client.city.findUniqueOrThrow({ where: { code: 'AAA' } });
    assert.equal(city.coverageMode, 'WHOLE_CITY');
    assert.equal(Number(city.maxSurgeMultiplier), 2);

    const zoneId = await ensureServiceZone('AAA', 'AAA_SZ', 'Zone', BOUNDARY);
    const window = await db().client.surgeWindow.create({
      data: { serviceZoneId: zoneId, multiplier: 1.2, startsAt: new Date() },
    });
    assert.equal(window.source, 'MANUAL');
    assert.deepEqual(window.daysOfWeek, []);
    assert.deepEqual(window.vehicleTypeIds, []);
  });
});
