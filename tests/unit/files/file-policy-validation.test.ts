import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertDeclaredUploadAllowed,
  assertStoredObjectAllowed,
  peekBudgetFor,
  sanitizeFileName,
} from '../../../src/modules/files/policies/file.policy.js';
import {
  FileTooLargeError,
  UnsupportedMediaTypeError,
} from '../../../src/modules/files/errors/file.errors.js';

describe('filename policy (R-FILE-28, doc 02 §5.1)', () => {
  it('keeps only the basename, so traversal never survives', () => {
    assert.equal(sanitizeFileName('../../etc/passwd', 'application/pdf'), 'passwd.pdf');
    assert.equal(sanitizeFileName('..\\..\\windows\\system32', 'application/pdf'), 'system32.pdf');
  });

  it('derives the extension from the content-type and discards the client’s', () => {
    assert.equal(sanitizeFileName('licence.PDF.exe', 'application/pdf'), 'licence.PDF.pdf');
    assert.equal(sanitizeFileName('photo.png', 'image/jpeg'), 'photo.jpg');
  });

  it('strips bidirectional overrides — the spoof a reviewer would fall for', () => {
    const spoofed = `invoice${String.fromCodePoint(0x202e)}gnp.exe`;
    const cleaned = sanitizeFileName(spoofed, 'image/png');
    assert.equal(cleaned.includes(String.fromCodePoint(0x202e)), false);
    assert.match(cleaned, /\.png$/);
  });

  it('strips control characters, including NUL', () => {
    const nasty = `re${String.fromCodePoint(0x00)}port${String.fromCodePoint(0x1f)}`;
    const cleaned = sanitizeFileName(nasty, 'application/pdf');
    assert.equal(cleaned, 'report.pdf');
  });

  it('replaces path and shell metacharacters', () => {
    assert.equal(sanitizeFileName('a:b*c?d"e<f>g|h', 'image/png'), 'a_b_c_d_e_f_g_h.png');
  });

  it('preserves Unicode and emoji — this platform writes in Urdu and Hindi', () => {
    assert.equal(sanitizeFileName('لائسنس.jpg', 'image/jpeg'), 'لائسنس.jpg');
    assert.equal(sanitizeFileName('लाइसेंस.jpg', 'image/jpeg'), 'लाइसेंस.jpg');
    assert.match(sanitizeFileName('holiday 🎉.png', 'image/png'), /🎉/);
  });

  it('suffixes a Windows reserved device name', () => {
    assert.equal(sanitizeFileName('CON.pdf', 'application/pdf'), 'CON_.pdf');
    assert.equal(sanitizeFileName('lpt9.png', 'image/png'), 'lpt9_.png');
  });

  it('never returns an empty name', () => {
    assert.equal(sanitizeFileName('', 'image/png'), 'file.png');
    assert.equal(sanitizeFileName('...', 'image/png'), 'file.png');
    assert.equal(sanitizeFileName('/', 'image/png'), 'file.png');
  });

  it('caps the length in UTF-8 bytes, not characters', () => {
    const long = 'ا'.repeat(400);
    const cleaned = sanitizeFileName(long, 'image/png');
    assert.ok(Buffer.byteLength(cleaned) <= 255, `was ${Buffer.byteLength(cleaned)} bytes`);
    assert.match(cleaned, /\.png$/);
  });

  it('never splits a multi-byte code point when truncating', () => {
    const cleaned = sanitizeFileName('🎉'.repeat(200), 'image/png');

    assert.equal(cleaned.includes('�'), false);
  });
});

describe('declared-intent validation (R-FILE-4)', () => {
  it('refuses a content-type absent from the purpose allow-list', () => {
    assert.throws(
      () => assertDeclaredUploadAllowed('PROFILE_IMAGE', 'application/pdf', 1024),
      UnsupportedMediaTypeError,
    );
  });

  it('carries the allow-list so the client can say what IS accepted', () => {
    try {
      assertDeclaredUploadAllowed('PROFILE_IMAGE', 'application/pdf', 1024);
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof UnsupportedMediaTypeError);
      assert.deepEqual(error.details?.[0]?.allowed, ['image/jpeg', 'image/png', 'image/webp']);
    }
  });

  it('refuses a declared size over the ceiling, before anything is signed', () => {
    assert.throws(
      () => assertDeclaredUploadAllowed('PROFILE_IMAGE', 'image/jpeg', 50 * 1024 * 1024),
      FileTooLargeError,
    );
  });

  it('accepts a permitted type at the ceiling exactly', () => {
    assert.doesNotThrow(() =>
      assertDeclaredUploadAllowed('PROFILE_IMAGE', 'image/jpeg', 5 * 1024 * 1024),
    );
  });
});

describe('stored-object validation (R-FILE-5, R-FILE-35)', () => {
  it('refuses an object whose real size exceeds the ceiling', () => {
    assert.throws(
      () => assertStoredObjectAllowed('PROFILE_IMAGE', 'image/jpeg', 6 * 1024 * 1024, null),
      FileTooLargeError,
    );
  });

  it('refuses a decompression bomb on pixel count alone', () => {
    assert.throws(
      () =>
        assertStoredObjectAllowed('PROFILE_IMAGE', 'image/png', 4096, {
          width: 40000,
          height: 40000,
        }),
      FileTooLargeError,
    );
  });

  it('accepts an ordinary photograph within both ceilings', () => {
    assert.doesNotThrow(() =>
      assertStoredObjectAllowed('PROFILE_IMAGE', 'image/jpeg', 2 * 1024 * 1024, {
        width: 3024,
        height: 4032,
      }),
    );
  });

  it('applies no pixel ceiling to a format it never parses', () => {
    assert.doesNotThrow(() =>
      assertStoredObjectAllowed('DRIVER_DOCUMENT', 'application/pdf', 1024, null),
    );
  });
});

describe('peek budget (doc 08 §2)', () => {
  it('asks for the image budget only where dimensions must be read', () => {
    assert.equal(peekBudgetFor('image/jpeg', 512, 131072), 131072);
    assert.equal(peekBudgetFor('image/png', 512, 131072), 131072);
    assert.equal(peekBudgetFor('image/webp', 512, 131072), 131072);
  });

  it('asks only for the signature budget otherwise', () => {
    assert.equal(peekBudgetFor('application/pdf', 512, 131072), 512);
    assert.equal(peekBudgetFor('video/mp4', 512, 131072), 512);
  });
});
