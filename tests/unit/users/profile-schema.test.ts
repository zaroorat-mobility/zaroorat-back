import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  IMMUTABLE_PROFILE_FIELDS,
  detailsFromZodIssues,
  findImmutableFields,
  parseDateOnly,
  updateProfileSchema,
} from '../../../src/modules/users/http/user.schemas.js';

/** Parse and return the doc 04 §6 details for a failing body. */
function detailsFor(body: unknown) {
  const parsed = updateProfileSchema.safeParse(body);
  assert.equal(parsed.success, false, 'expected the body to be rejected');
  return detailsFromZodIssues(parsed.error!.issues);
}

/** The `code` reported for a single-field failure. */
function codeFor(body: unknown, field: string): string | undefined {
  return detailsFor(body).find((d) => d.field === field)?.code;
}

// Validation rules for PATCH /me/profile (doc 02 §2.2) and the details
// vocabulary (doc 04 §6). The privacy assertion — details never carry the
// submitted value (doc 04 §5) — is the one that matters most here.
describe('user profile schema (unit)', () => {
  describe('partial-update semantics (R-USER-5)', () => {
    it('accepts an empty body — nothing present means nothing changes', () => {
      const parsed = updateProfileSchema.safeParse({});
      assert.equal(parsed.success, true);
      assert.deepEqual(Object.keys(parsed.data!), []);
    });

    it('keeps absent keys absent, so the writer can tell them from null', () => {
      const parsed = updateProfileSchema.safeParse({ firstName: 'Aarav' });
      assert.equal(parsed.success, true);
      assert.equal(Object.hasOwn(parsed.data!, 'firstName'), true);
      assert.equal(Object.hasOwn(parsed.data!, 'lastName'), false);
    });

    it('preserves an explicit null as a clear instruction', () => {
      const parsed = updateProfileSchema.safeParse({ lastName: null });
      assert.equal(parsed.success, true);
      assert.equal(Object.hasOwn(parsed.data!, 'lastName'), true);
      assert.equal(parsed.data!.lastName, null);
    });
  });

  describe('field rules', () => {
    it('trims names and rejects empty, oversized, and digit-bearing ones', () => {
      assert.equal(
        updateProfileSchema.safeParse({ firstName: '  Aarav  ' }).data?.firstName,
        'Aarav',
      );
      assert.equal(codeFor({ firstName: '' }, 'firstName'), 'REQUIRED');
      assert.equal(codeFor({ firstName: 'a'.repeat(65) }, 'firstName'), 'TOO_LONG');
      assert.equal(codeFor({ firstName: 'Aarav99' }, 'firstName'), 'INVALID_FORMAT');
    });

    it('accepts names with marks, hyphens, and apostrophes', () => {
      for (const name of ['आरव', "O'Brien", 'Jean-Luc', 'María']) {
        assert.equal(
          updateProfileSchema.safeParse({ firstName: name }).success,
          true,
          `${name} should be a valid name`,
        );
      }
    });

    it('distinguishes malformed, future, and under-age dates of birth', () => {
      assert.equal(updateProfileSchema.safeParse({ dateOfBirth: '1994-03-11' }).success, true);
      assert.equal(codeFor({ dateOfBirth: '11-03-1994' }, 'dateOfBirth'), 'INVALID_FORMAT');
      assert.equal(codeFor({ dateOfBirth: '2026-02-30' }, 'dateOfBirth'), 'INVALID_FORMAT');
      assert.equal(codeFor({ dateOfBirth: '2999-01-01' }, 'dateOfBirth'), 'MUST_BE_PAST');

      const lastYear = new Date();
      lastYear.setUTCFullYear(lastYear.getUTCFullYear() - 1);
      assert.equal(
        codeFor({ dateOfBirth: lastYear.toISOString().slice(0, 10) }, 'dateOfBirth'),
        'AGE_BELOW_MINIMUM',
      );
    });

    it('answers one bad date with exactly one code', () => {
      // Every rule on this field runs independently, so a future date used to
      // come back as MUST_BE_PAST *and* AGE_BELOW_MINIMUM — two contradictory
      // pieces of copy for one mistake. Each date has exactly one reason.
      for (const value of ['11-03-1994', '2026-02-30', '2999-01-01']) {
        assert.equal(detailsFor({ dateOfBirth: value }).length, 1, value);
      }
    });

    it('constrains gender to the accepted set (USER-OD-5)', () => {
      assert.equal(updateProfileSchema.safeParse({ gender: 'PREFER_NOT_TO_SAY' }).success, true);
      assert.equal(codeFor({ gender: 'male' }, 'gender'), 'NOT_ALLOWED');
    });

    it('constrains languageCode to the supported set (R-USER-7)', () => {
      assert.equal(updateProfileSchema.safeParse({ languageCode: 'hi' }).success, true);
      assert.equal(codeFor({ languageCode: 'kl' }, 'languageCode'), 'NOT_ALLOWED');
    });

    it('takes an avatar as a file id, and rejects anything that is not one', () => {
      assert.equal(
        updateProfileSchema.safeParse({ profileImageFileId: randomUUID() }).success,
        true,
      );
      assert.equal(updateProfileSchema.safeParse({ profileImageFileId: null }).success, true);
      assert.equal(
        codeFor({ profileImageFileId: 'not-a-uuid' }, 'profileImageFileId'),
        'INVALID_FORMAT',
      );
    });

    it('refuses the old profileImage URL outright, rather than ignoring it', () => {
      // Deploy 3 removed the field (files doc 03 §7.2). A strict object reports
      // it by name, so a client still sending a URL learns that it did nothing —
      // a silent drop would look exactly like success.
      assert.equal(
        codeFor({ profileImage: 'https://cdn.zaroorat.com/a.png' }, 'profileImage'),
        'NOT_ALLOWED',
      );
    });
  });

  describe('immutable fields (USER-INV-5, doc 02 §2.2)', () => {
    it('detects every immutable field, individually and as a batch', () => {
      for (const field of IMMUTABLE_PROFILE_FIELDS) {
        assert.deepEqual(findImmutableFields({ [field]: 'x' }), [field]);
      }
      assert.deepEqual(findImmutableFields({ phoneNumber: '+91', status: 'ACTIVE', roles: [] }), [
        'phoneNumber',
        'status',
        'roles',
      ]);
    });

    it('covers email-verification state, which doc 02 §2.2 omits but USER-INV-5 requires', () => {
      assert.deepEqual(findImmutableFields({ isEmailVerified: true }), ['isEmailVerified']);
    });

    it('ignores a writable body and a non-object body', () => {
      assert.deepEqual(findImmutableFields({ firstName: 'Aarav' }), []);
      assert.deepEqual(findImmutableFields(null), []);
      assert.deepEqual(findImmutableFields('nope'), []);
    });
  });

  describe('unknown keys are rejected, never silently dropped', () => {
    it('reports an unknown key as NOT_ALLOWED against its own name', () => {
      assert.deepEqual(detailsFor({ nickname: 'Ari' }), [
        { field: 'nickname', code: 'NOT_ALLOWED' },
      ]);
    });
  });

  describe('privacy (doc 04 §5)', () => {
    it('never echoes a submitted value in details', () => {
      const secret = 'Aarav-Sharma-1994-03-11';
      const details = detailsFor({
        firstName: `${secret}9`,
        dateOfBirth: secret,
        gender: secret,
        profileImageFileId: secret,
        languageCode: secret,
      });
      assert.ok(details.length > 0);
      for (const detail of details) {
        assert.deepEqual(
          Object.keys(detail).sort(),
          ['code', 'field'],
          'a detail carries field and code only',
        );
        assert.ok(
          !JSON.stringify(detail).includes(secret),
          'no submitted value leaks into details',
        );
      }
    });
  });

  describe('parseDateOnly', () => {
    it('parses a calendar date to UTC midnight and round-trips it', () => {
      const parsed = parseDateOnly('1994-03-11');
      assert.ok(parsed);
      assert.equal(parsed.toISOString(), '1994-03-11T00:00:00.000Z');
      assert.equal(parsed.toISOString().slice(0, 10), '1994-03-11');
    });

    it('rejects overflow dates the Date constructor would roll over', () => {
      assert.equal(parseDateOnly('2026-02-30'), null);
      assert.equal(parseDateOnly('2026-13-01'), null);
      assert.equal(parseDateOnly('11-03-1994'), null);
    });
  });
});
