import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createStateBodySchema,
  listStatesQuerySchema,
  reconcileApplyBodySchema,
  reconcilePreviewQuerySchema,
  updateStateBodySchema,
} from '../../../src/modules/admin/geographic-management/geo.schemas.js';

describe('Geographic Master Data - Canonical LGD Dataset Integrity', () => {
  const jsonPath = path.resolve(process.cwd(), 'prisma/seed/reference/india-states-lgd.json');
  assert.ok(fs.existsSync(jsonPath), 'india-states-lgd.json must exist');

  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const dataset = JSON.parse(raw);

  it('contains valid metadata with 28 States and 8 Union Territories', () => {
    assert.equal(dataset.metadata.countryCode, 'IN');
    assert.equal(dataset.metadata.totalRecords, 36);
    assert.equal(dataset.metadata.breakdown.states, 28);
    assert.equal(dataset.metadata.breakdown.unionTerritories, 8);
    assert.ok(dataset.metadata.version);
    assert.ok(dataset.metadata.source);
  });

  it('has exactly 36 records matching metadata breakdown', () => {
    assert.equal(dataset.records.length, 36);

    const states = dataset.records.filter(
      (r: { divisionType: string }) => r.divisionType === 'STATE',
    );
    const uts = dataset.records.filter(
      (r: { divisionType: string }) => r.divisionType === 'UNION_TERRITORY',
    );

    assert.equal(states.length, 28, 'Should have exactly 28 States');
    assert.equal(uts.length, 8, 'Should have exactly 8 Union Territories');
  });

  it('has unique 2-letter uppercase codes', () => {
    const codes = dataset.records.map((r: { code: string }) => r.code);
    const uniqueCodes = new Set(codes);

    assert.equal(codes.length, uniqueCodes.size, 'All state codes must be unique');
    for (const code of codes) {
      assert.match(code, /^[A-Z]{2}$/, `Code ${code} must be a 2-letter uppercase string`);
    }
  });

  it('has unique LGD codes in valid range', () => {
    const lgdCodes = dataset.records.map((r: { lgdCode: number }) => r.lgdCode);
    const uniqueLgd = new Set(lgdCodes);

    assert.equal(lgdCodes.length, uniqueLgd.size, 'All LGD codes must be unique');
    for (const code of lgdCodes) {
      assert.ok(
        typeof code === 'number' && Number.isInteger(code) && code > 0 && code <= 38,
        `LGD code ${code} must be valid integer`,
      );
    }
  });

  it('has unique ISO 3166-2:IN codes', () => {
    const isoCodes = dataset.records.map((r: { isoCode: string }) => r.isoCode);
    const uniqueIso = new Set(isoCodes);

    assert.equal(isoCodes.length, uniqueIso.size, 'All ISO codes must be unique');
    for (const iso of isoCodes) {
      assert.match(iso, /^IN-[A-Z]{2}$/, `ISO code ${iso} must match IN-XX pattern`);
    }
  });

  it('contains legacy dev codes JK, KA, MH with canonical names', () => {
    const jk = dataset.records.find((r: { code: string }) => r.code === 'JK');
    assert.ok(jk, 'JK must exist in dataset');
    assert.equal(jk.name, 'Jammu and Kashmir');
    assert.equal(jk.divisionType, 'UNION_TERRITORY');
    assert.equal(jk.lgdCode, 1);
    assert.equal(jk.isoCode, 'IN-JK');

    const ka = dataset.records.find((r: { code: string }) => r.code === 'KA');
    assert.ok(ka, 'KA must exist in dataset');
    assert.equal(ka.name, 'Karnataka');
    assert.equal(ka.divisionType, 'STATE');
    assert.equal(ka.lgdCode, 29);
    assert.equal(ka.isoCode, 'IN-KA');

    const mh = dataset.records.find((r: { code: string }) => r.code === 'MH');
    assert.ok(mh, 'MH must exist in dataset');
    assert.equal(mh.name, 'Maharashtra');
    assert.equal(mh.divisionType, 'STATE');
    assert.equal(mh.lgdCode, 27);
    assert.equal(mh.isoCode, 'IN-MH');
  });
});

describe('Geographic Master Data - Zod Validation Schemas', () => {
  it('validates listStatesQuerySchema with divisionType and activeOnly', () => {
    const validState = listStatesQuerySchema.parse({ divisionType: 'STATE', activeOnly: 'true' });
    assert.equal(validState.divisionType, 'STATE');
    assert.equal(validState.activeOnly, true);

    const validUt = listStatesQuerySchema.parse({
      divisionType: 'UNION_TERRITORY',
      activeOnly: false,
    });
    assert.equal(validUt.divisionType, 'UNION_TERRITORY');
    assert.equal(validUt.activeOnly, false);

    assert.throws(() => listStatesQuerySchema.parse({ divisionType: 'PROVINCE' }));
  });

  it('validates createStateBodySchema with defaults and new fields', () => {
    const parsed = createStateBodySchema.parse({
      code: 'DL',
      name: 'Delhi',
      divisionType: 'UNION_TERRITORY',
      lgdCode: 7,
      isoCode: 'IN-DL',
      nativeName: 'दिल्ली',
      censusCode: '07',
    });

    assert.equal(parsed.countryCode, 'IN');
    assert.equal(parsed.divisionType, 'UNION_TERRITORY');
    assert.equal(parsed.lgdCode, 7);
    assert.equal(parsed.isoCode, 'IN-DL');
    assert.equal(parsed.nativeName, 'दिल्ली');
    assert.equal(parsed.isActive, true);
  });

  it('validates updateStateBodySchema allowing partial canonical updates', () => {
    const parsed = updateStateBodySchema.parse({
      nativeName: 'महाराष्ट्र',
      lgdCode: 27,
      divisionType: 'STATE',
    });

    assert.equal(parsed.nativeName, 'महाराष्ट्र');
    assert.equal(parsed.lgdCode, 27);
    assert.equal(parsed.divisionType, 'STATE');
  });

  it('validates reconcilePreviewQuerySchema and reconcileApplyBodySchema', () => {
    const preview = reconcilePreviewQuerySchema.parse({});
    assert.equal(preview.countryCode, 'IN');

    const apply = reconcileApplyBodySchema.parse({
      countryCode: 'IN',
      confirm: true,
      expectedVersion: '2026.1',
    });
    assert.equal(apply.confirm, true);
    assert.equal(apply.expectedVersion, '2026.1');

    assert.throws(() => reconcileApplyBodySchema.parse({ confirm: false }));
  });
});
