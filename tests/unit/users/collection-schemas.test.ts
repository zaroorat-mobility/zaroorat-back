import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createContactSchema,
  createPlaceSchema,
  detailsFromZodIssues,
  itemIdSchema,
  updateContactSchema,
  updatePlaceSchema,
} from '../../../src/modules/users/schemas/user.schemas.js';
import type { ErrorDetail } from '../../../src/modules/users/errors/user.errors.js';

function detailsFor(schema: { safeParse: (v: unknown) => unknown }, body: unknown): ErrorDetail[] {
  const parsed = schema.safeParse(body) as
    { success: true } | { success: false; error: { issues: never[] } };
  return parsed.success ? [] : detailsFromZodIssues(parsed.error.issues);
}

function codeFor(
  schema: { safeParse: (v: unknown) => unknown },
  body: unknown,
): string | undefined {
  return detailsFor(schema, body)[0]?.code;
}

const CONTACT = { contactName: 'Priya', phoneNumber: '+919876500042' };
const PLACE = { label: 'Home' };

describe('emergency contact schema (unit)', () => {
  it('accepts the doc 02 §2.5 body', () => {
    const parsed = createContactSchema.parse({
      contactName: 'Priya',
      phoneNumber: '+919876500042',
      relationship: 'SPOUSE',
      priority: 1,
    });
    assert.deepEqual(parsed, {
      contactName: 'Priya',
      phoneNumber: '+919876500042',
      relationship: 'SPOUSE',
      priority: 1,
    });
  });

  it('requires a name and an E.164 number', () => {
    assert.equal(codeFor(createContactSchema, { phoneNumber: '+919876500042' }), 'INVALID_FORMAT');
    assert.equal(codeFor(createContactSchema, { ...CONTACT, contactName: '' }), 'REQUIRED');
    assert.equal(
      codeFor(createContactSchema, { ...CONTACT, contactName: 'x'.repeat(65) }),
      'TOO_LONG',
    );
    assert.equal(
      codeFor(createContactSchema, { ...CONTACT, phoneNumber: '9876500042' }),
      'INVALID_FORMAT',
    );
  });

  it('constrains priority to a whole rank, one or greater (R-USER-23)', () => {
    assert.equal(codeFor(createContactSchema, { ...CONTACT, priority: 0 }), 'OUT_OF_RANGE');
    assert.equal(codeFor(createContactSchema, { ...CONTACT, priority: 1.5 }), 'INVALID_FORMAT');
    assert.equal(codeFor(createContactSchema, { ...CONTACT, priority: 3 }), undefined);
  });

  it('lets relationship be cleared but never the NOT NULL columns', () => {
    assert.equal(codeFor(updateContactSchema, { relationship: null }), undefined);

    assert.ok(codeFor(updateContactSchema, { contactName: null }) !== undefined);
    assert.ok(codeFor(updateContactSchema, { phoneNumber: null }) !== undefined);
  });

  it('rejects an unknown key rather than dropping it', () => {
    assert.deepEqual(detailsFor(createContactSchema, { ...CONTACT, isPrimary: true }), [
      { field: 'isPrimary', code: 'NOT_ALLOWED' },
    ]);
  });

  it('never echoes a submitted value in details (doc 04 §5)', () => {
    const details = detailsFor(createContactSchema, {
      contactName: 'Priya Sharma',
      phoneNumber: 'not-a-number',
    });
    assert.ok(!JSON.stringify(details).includes('Priya'));
    assert.ok(!JSON.stringify(details).includes('not-a-number'));
  });
});

describe('saved place schema (unit)', () => {
  it('accepts the doc 02 §2.6 body', () => {
    const body = {
      label: 'Home',
      address: '12 MG Road, Bengaluru',
      buildingName: 'Sunrise Apartments',
      landmark: 'opposite the metro station',
      floor: '3B',
      instructions: 'Call on arrival, the gate is locked after 10pm',
      latitude: 12.9716,
      longitude: 77.5946,
    };
    assert.deepEqual(createPlaceSchema.parse(body), body);
  });

  it('requires a label of one to thirty-two characters', () => {
    assert.equal(codeFor(createPlaceSchema, {}), 'INVALID_FORMAT');
    assert.equal(codeFor(createPlaceSchema, { label: '' }), 'REQUIRED');
    assert.equal(codeFor(createPlaceSchema, { label: 'x'.repeat(33) }), 'TOO_LONG');
  });

  it('bounds instructions, because they reach a driver’s screen', () => {
    assert.equal(
      codeFor(createPlaceSchema, { ...PLACE, instructions: 'x'.repeat(280) }),
      undefined,
    );
    assert.equal(
      codeFor(createPlaceSchema, { ...PLACE, instructions: 'x'.repeat(281) }),
      'TOO_LONG',
    );
  });

  it('bounds coordinates to the real world', () => {
    assert.equal(
      codeFor(createPlaceSchema, { ...PLACE, latitude: 91, longitude: 0 }),
      'OUT_OF_RANGE',
    );
    assert.equal(
      codeFor(createPlaceSchema, { ...PLACE, latitude: 0, longitude: 181 }),
      'OUT_OF_RANGE',
    );
    assert.equal(
      codeFor(createPlaceSchema, { ...PLACE, latitude: -90, longitude: -180 }),
      undefined,
    );
  });

  it('refuses a half-set point, in either direction', () => {
    assert.deepEqual(detailsFor(createPlaceSchema, { ...PLACE, latitude: 12.97 }), [
      { field: 'longitude', code: 'REQUIRED' },
    ]);
    assert.deepEqual(detailsFor(createPlaceSchema, { ...PLACE, longitude: 77.59 }), [
      { field: 'longitude', code: 'REQUIRED' },
    ]);
    assert.deepEqual(detailsFor(updatePlaceSchema, { latitude: null, longitude: 77.59 }), [
      { field: 'longitude', code: 'REQUIRED' },
    ]);
  });

  it('accepts clearing both coordinates together', () => {
    assert.equal(codeFor(updatePlaceSchema, { latitude: null, longitude: null }), undefined);
    assert.equal(
      codeFor(updatePlaceSchema, { label: 'Work' }),
      undefined,
      'neither is also a pair',
    );
  });

  it('rejects a geometry the client tried to send itself', () => {
    assert.deepEqual(detailsFor(createPlaceSchema, { ...PLACE, location: 'POINT(0 0)' }), [
      { field: 'location', code: 'NOT_ALLOWED' },
    ]);
  });
});

describe('path id schema (unit)', () => {
  it('accepts a UUID and rejects anything else', () => {
    assert.equal(itemIdSchema.safeParse('019fbd91-440e-76be-93d9-145f0da468f7').success, true);
    for (const bad of ['', 'abc', '1', '019fbd91-440e-76be-93d9']) {
      assert.equal(itemIdSchema.safeParse(bad).success, false, bad);
    }
  });
});
