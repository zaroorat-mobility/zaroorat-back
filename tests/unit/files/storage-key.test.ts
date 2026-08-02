import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STORAGE_KEY_PATTERN, buildStorageKey } from '../../../src/modules/files/storage-key.js';
import type { FilePurposeName } from '../../../src/config/file/file.config.js';

/**
 * Storage-key construction (files doc 03 §5). The unguessability assertions are
 * the security-relevant ones: a key must reveal nothing about its owner and must
 * not let someone holding one key derive another (R-FILE-7).
 */
describe('buildStorageKey', () => {
  const AUGUST = new Date('2026-08-02T10:15:00Z');

  it('matches the documented grammar', () => {
    const key = buildStorageKey('DRIVER_DOCUMENT', 'application/pdf', AUGUST);
    assert.match(key, STORAGE_KEY_PATTERN);
    assert.match(key, /^dd\/2026\/08\/[0-9a-f]{32}\.pdf$/);
  });

  it('uses the right two-letter prefix for every purpose', () => {
    const expected: Record<FilePurposeName, string> = {
      PROFILE_IMAGE: 'pi',
      DRIVER_DOCUMENT: 'dd',
      VEHICLE_DOCUMENT: 'vd',
      VEHICLE_IMAGE: 'vi',
      SOS_EVIDENCE: 'se',
      DISPUTE_EVIDENCE: 'de',
    };

    for (const [purpose, prefix] of Object.entries(expected)) {
      const key = buildStorageKey(purpose as FilePurposeName, 'image/jpeg', AUGUST);
      assert.equal(key.split('/')[0], prefix, purpose);
      assert.match(key, STORAGE_KEY_PATTERN);
    }
  });

  it('derives the extension from the content-type, never from a filename', () => {
    assert.match(buildStorageKey('PROFILE_IMAGE', 'image/jpeg', AUGUST), /\.jpg$/);
    assert.match(buildStorageKey('PROFILE_IMAGE', 'image/png', AUGUST), /\.png$/);
    assert.match(buildStorageKey('PROFILE_IMAGE', 'image/webp', AUGUST), /\.webp$/);
    assert.match(buildStorageKey('DRIVER_DOCUMENT', 'application/pdf', AUGUST), /\.pdf$/);
    assert.match(buildStorageKey('SOS_EVIDENCE', 'video/mp4', AUGUST), /\.mp4$/);
  });

  it('refuses a content-type with no mapped extension', () => {
    // Reaching here means an allow-list check upstream is broken, so it throws
    // rather than inventing an extension.
    assert.throws(
      () => buildStorageKey('PROFILE_IMAGE', 'application/octet-stream', AUGUST),
      /No extension mapped/,
    );
  });

  it('partitions by UTC year and month', () => {
    const january = buildStorageKey('PROFILE_IMAGE', 'image/png', new Date('2027-01-31T23:59:59Z'));
    assert.match(january, /^pi\/2027\/01\//);
  });

  it('zero-pads the month, so the grammar is fixed-width', () => {
    const key = buildStorageKey('PROFILE_IMAGE', 'image/png', new Date('2026-09-01T00:00:00Z'));
    assert.match(key, /^pi\/2026\/09\//);
  });

  // ── The properties that make a leaked key useless ─────────────────────────

  describe('unguessability (R-FILE-7)', () => {
    const keys = Array.from({ length: 1000 }, () =>
      buildStorageKey('DRIVER_DOCUMENT', 'application/pdf', AUGUST),
    );

    it('never repeats', () => {
      assert.equal(new Set(keys).size, keys.length);
    });

    it('carries no user id, file id, or filename', () => {
      // Nothing identifying can appear, because nothing identifying is an input:
      // the only variable part is CSPRNG output.
      const random = keys.map((key) => key.split('/')[3]?.replace('.pdf', '') ?? '');
      for (const value of random) assert.match(value, /^[0-9a-f]{32}$/);
    });

    it('is not derivable from a uuid v7 row id, which would be time-adjacent', () => {
      // The v4 choice is deliberate (doc 03 §5): a v7 leaks its creation instant
      // and neighbouring ids share a prefix, so one leaked id would expose the
      // keys minted beside it. Adjacent v4 keys share no prefix beyond chance.
      const sortedRandomParts = keys.map((key) => key.split('/')[3] ?? '').sort();
      let longestSharedPrefix = 0;
      for (let index = 1; index < sortedRandomParts.length; index += 1) {
        const previous = sortedRandomParts[index - 1] ?? '';
        const current = sortedRandomParts[index] ?? '';
        let shared = 0;
        while (shared < previous.length && previous[shared] === current[shared]) shared += 1;
        longestSharedPrefix = Math.max(longestSharedPrefix, shared);
      }
      // Across 1000 draws from 128 bits, a shared prefix beyond a few hex digits
      // would mean the source is not random. Generous bound: this asserts the
      // absence of structure, not a specific entropy figure.
      assert.ok(
        longestSharedPrefix <= 8,
        `adjacent keys shared ${longestSharedPrefix} hex chars — key source is not random`,
      );
    });
  });
});
