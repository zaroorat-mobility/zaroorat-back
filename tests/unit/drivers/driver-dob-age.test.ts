import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateDriverDob,
  driverDobSchema,
  updateDriverProfileSchema,
} from '../../../src/modules/drivers/schemas/driver.schemas.js';

describe('Driver DOB & Minimum Age Enforcement (Phase 9 & 18)', () => {
  // Use a fixed reference date: 2026-10-04T00:00:00.000Z
  const mockNow = new Date(Date.UTC(2026, 9, 4, 12, 0, 0)); // 2026-10-04

  it('allows a driver who is exactly 18 years old today', () => {
    // Born on 2008-10-04, today is 2026-10-04 -> exactly 18 years old
    const res = validateDriverDob('2008-10-04', mockNow);
    assert.equal(res.valid, true);
    assert.notEqual(res.parsedDate, undefined);
  });

  it('rejects a driver who is 17 years and 364 days old (birthday is tomorrow)', () => {
    // Born on 2008-10-05, today is 2026-10-04 -> 17 years 364 days old
    const res = validateDriverDob('2008-10-05', mockNow);
    assert.equal(res.valid, false);
    assert.equal(res.code, 'AGE_BELOW_MINIMUM');
    assert.match(res.message || '', /at least 18 years old/i);
  });

  it('allows older driver (e.g. 25 years old)', () => {
    const res = validateDriverDob('2001-05-15', mockNow);
    assert.equal(res.valid, true);
  });

  it('rejects future date of birth', () => {
    const res = validateDriverDob('2026-10-05', mockNow);
    assert.equal(res.valid, false);
    assert.equal(res.code, 'MUST_BE_PAST');
  });

  it('rejects distant future date of birth', () => {
    const res = validateDriverDob('2099-01-01', mockNow);
    assert.equal(res.valid, false);
    assert.equal(res.code, 'MUST_BE_PAST');
  });

  it('rejects impossible calendar dates', () => {
    // Feb 30th
    const res1 = validateDriverDob('2000-02-30', mockNow);
    assert.equal(res1.valid, false);
    assert.equal(res1.code, 'INVALID_CALENDAR_DATE');

    // April 31st
    const res2 = validateDriverDob('2000-04-31', mockNow);
    assert.equal(res2.valid, false);
    assert.equal(res2.code, 'INVALID_CALENDAR_DATE');

    // Feb 29 on non-leap year (2001)
    const res3 = validateDriverDob('2001-02-29', mockNow);
    assert.equal(res3.valid, false);
    assert.equal(res3.code, 'INVALID_CALENDAR_DATE');
  });

  it('accepts Feb 29 on a valid leap year if age >= 18', () => {
    // 2004 was a leap year, in 2026 age is 22
    const res = validateDriverDob('2004-02-29', mockNow);
    assert.equal(res.valid, true);
  });

  it('rejects malformed and non-date strings', () => {
    for (const bad of ['11-03-1994', '04/10/2008', 'not-a-date', '', '2000-13-01', '2000-00-10']) {
      const res = validateDriverDob(bad, mockNow);
      assert.equal(res.valid, false, `Expected ${bad} to be invalid`);
    }
  });

  it('enforces driverDobSchema via Zod safeParse', () => {
    const valid = driverDobSchema.safeParse('1994-03-11');
    assert.equal(valid.success, true);

    const underage = driverDobSchema.safeParse('2020-01-01');
    assert.equal(underage.success, false);

    const invalidDate = driverDobSchema.safeParse('2000-02-30');
    assert.equal(invalidDate.success, false);
  });

  it('integrates with updateDriverProfileSchema', () => {
    const validProfile = updateDriverProfileSchema.safeParse({
      fullLegalName: 'Aarav Sharma',
      dateOfBirth: '1995-07-20',
      gender: 'MALE',
    });
    assert.equal(validProfile.success, true);

    const underageProfile = updateDriverProfileSchema.safeParse({
      fullLegalName: 'Kid Driver',
      dateOfBirth: '2020-05-10',
    });
    assert.equal(underageProfile.success, false);
    assert.match(underageProfile.error?.issues[0]?.message || '', /at least 18 years old/i);
  });
});
