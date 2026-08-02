import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasEnforceableDimensions,
  inspect,
  matchesSignature,
} from '../../../src/modules/files/content-inspector.js';

/** Build a PNG header with the given IHDR dimensions. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/**
 * Build a JPEG header: SOI, an optional filler segment of `padBytes`, then SOF0.
 * The filler stands in for the EXIF block, ICC profiles, and thumbnail that
 * precede the frame header in a real camera photograph.
 */
function jpeg(width: number, height: number, padBytes = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (padBytes > 0) {
    const segment = Buffer.alloc(padBytes + 4);
    segment[0] = 0xff;
    segment[1] = 0xe1; // APP1, which is where EXIF lives
    segment.writeUInt16BE(padBytes + 2, 2);
    parts.push(segment);
  }
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2);
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

/** Build a lossy (`VP8 `) WebP header. */
function webpLossy(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(22, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  buffer[23] = 0x9d;
  buffer[24] = 0x01;
  buffer[25] = 0x2a;
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
}

/** Build an extended (`VP8X`) WebP header, used whenever alpha or animation is present. */
function webpExtended(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

describe('content inspector — magic bytes (doc 02 §5)', () => {
  it('accepts each declared type against its own signature', () => {
    assert.ok(matchesSignature('image/png', png(1, 1)));
    assert.ok(matchesSignature('image/jpeg', jpeg(1, 1)));
    assert.ok(matchesSignature('image/webp', webpLossy(1, 1)));
    assert.ok(matchesSignature('application/pdf', Buffer.from('%PDF-1.7')));
    assert.ok(matchesSignature('video/mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])));
  });

  it('rejects a PNG renamed as a JPEG', () => {
    assert.equal(matchesSignature('image/jpeg', png(10, 10)), false);
  });

  it('rejects an ELF executable renamed as a PDF — the case that matters', () => {
    // 0x7F 'E' 'L' 'F'. A renamed binary is the whole reason the declared
    // content-type is treated as a claim rather than a fact (doc 02 §5).
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    assert.equal(matchesSignature('application/pdf', elf), false);
    assert.deepEqual(inspect('application/pdf', elf), { ok: false, reason: 'MAGIC_MISMATCH' });
  });

  it('rejects a content-type it has no signature for', () => {
    assert.equal(matchesSignature('application/octet-stream', Buffer.alloc(64)), false);
  });

  it('rejects a header shorter than the signature', () => {
    assert.equal(matchesSignature('image/png', Buffer.from([0x89, 0x50])), false);
  });

  it('ignores the size field inside a WebP RIFF header', () => {
    // Bytes 4-7 are the file size and vary per file, so the signature must skip
    // them or every WebP but one would be refused.
    const a = webpLossy(4, 4);
    const b = webpLossy(4, 4);
    b.writeUInt32LE(999999, 4);
    assert.ok(matchesSignature('image/webp', a));
    assert.ok(matchesSignature('image/webp', b));
  });
});

describe('content inspector — dimensions (R-FILE-35)', () => {
  it('reads PNG dimensions from IHDR', () => {
    assert.deepEqual(inspect('image/png', png(1920, 1080)), {
      ok: true,
      dimensions: { width: 1920, height: 1080 },
    });
  });

  it('reads JPEG dimensions from the start-of-frame marker', () => {
    assert.deepEqual(inspect('image/jpeg', jpeg(4032, 3024)), {
      ok: true,
      dimensions: { width: 4032, height: 3024 },
    });
  });

  it('finds the JPEG frame header past a large EXIF block', () => {
    // A camera photograph carries EXIF, ICC, and a thumbnail before its frame
    // header. This is why the image peek budget is 128 KB and not 512 bytes.
    const withExif = jpeg(4032, 3024, 60000);
    assert.ok(withExif.length > 60000);
    assert.deepEqual(inspect('image/jpeg', withExif), {
      ok: true,
      dimensions: { width: 4032, height: 3024 },
    });
  });

  it('reads both WebP container variants', () => {
    assert.deepEqual(inspect('image/webp', webpLossy(800, 600)), {
      ok: true,
      dimensions: { width: 800, height: 600 },
    });
    assert.deepEqual(inspect('image/webp', webpExtended(1200, 900)), {
      ok: true,
      dimensions: { width: 1200, height: 900 },
    });
  });

  it('reports the declared size of a decompression bomb without decoding it', () => {
    // A ~4 KB PNG can legally declare 40,000 x 40,000 — 6.4 GB of RGBA. The
    // point is that the header says so, so the ceiling can refuse it before any
    // decoder allocates (doc 02 §5.2).
    const bomb = png(40000, 40000);
    assert.ok(bomb.length < 100, 'the header alone is tiny — that is the attack');
    assert.deepEqual(inspect('image/png', bomb), {
      ok: true,
      dimensions: { width: 40000, height: 40000 },
    });
  });

  it('fails closed when an image header yields no dimensions', () => {
    // A valid JPEG signature whose first segment declares a length running past
    // the peek, so the frame header is never reached. Real causes: truncation, a
    // malformed chain, or padding chosen to push SOF out of view. Accepting it
    // would mean accepting an image whose decoded cost is unknown.
    const unreachableFrame = Buffer.alloc(64, 0x11);
    unreachableFrame[0] = 0xff;
    unreachableFrame[1] = 0xd8;
    unreachableFrame[2] = 0xff;
    unreachableFrame[3] = 0xe0; // APP0
    unreachableFrame.writeUInt16BE(0xfffd, 4); // a length far beyond the buffer

    assert.ok(matchesSignature('image/jpeg', unreachableFrame), 'the signature is valid');
    assert.deepEqual(inspect('image/jpeg', unreachableFrame), {
      ok: false,
      reason: 'DIMENSIONS_UNREADABLE',
    });
  });

  it('carries no dimensions for formats it never parses', () => {
    // A PDF is a program; rendering one to measure it would be a far larger
    // surface than the measurement is worth (doc 02 §5.2).
    assert.deepEqual(inspect('application/pdf', Buffer.from('%PDF-1.7')), {
      ok: true,
      dimensions: null,
    });
    assert.equal(hasEnforceableDimensions('application/pdf'), false);
    assert.equal(hasEnforceableDimensions('video/mp4'), false);
  });

  it('knows which types it enforces dimensions for', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      assert.ok(hasEnforceableDimensions(type), type);
    }
  });
});
