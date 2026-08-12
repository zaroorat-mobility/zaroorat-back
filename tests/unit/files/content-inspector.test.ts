import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasEnforceableDimensions,
  inspect,
  matchesSignature,
} from '../../../src/modules/files/utils/content-inspector.js';

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width: number, height: number, padBytes = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (padBytes > 0) {
    const segment = Buffer.alloc(padBytes + 4);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment.writeUInt16BE(padBytes + 2, 2);
    parts.push(segment);
  }
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

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
    const a = webpLossy(4, 4);
    const b = webpLossy(4, 4);
    b.writeUInt32LE(999999, 4);
    assert.ok(matchesSignature('image/webp', a));
    assert.ok(matchesSignature('image/webp', b));
  });
});

function dimensionsOf(contentType: string, header: Buffer) {
  const result = inspect(contentType, header);
  assert.equal(result.ok, true, `header rejected: ${result.ok ? '' : result.reason}`);
  return result.ok ? result.dimensions : null;
}

describe('content inspector — dimensions (R-FILE-35)', () => {
  it('reads PNG dimensions from IHDR', () => {
    assert.deepEqual(dimensionsOf('image/png', png(1920, 1080)), { width: 1920, height: 1080 });
  });

  it('reads JPEG dimensions from the start-of-frame marker', () => {
    assert.deepEqual(dimensionsOf('image/jpeg', jpeg(4032, 3024)), { width: 4032, height: 3024 });
  });

  it('finds the JPEG frame header past a large EXIF block', () => {
    const withExif = jpeg(4032, 3024, 60000);
    assert.ok(withExif.length > 60000);
    assert.deepEqual(dimensionsOf('image/jpeg', withExif), { width: 4032, height: 3024 });
  });

  it('reads both WebP container variants', () => {
    assert.deepEqual(dimensionsOf('image/webp', webpLossy(800, 600)), { width: 800, height: 600 });
    assert.deepEqual(dimensionsOf('image/webp', webpExtended(1200, 900)), {
      width: 1200,
      height: 900,
    });
  });

  it('reports the declared size of a decompression bomb without decoding it', () => {
    const bomb = png(40000, 40000);
    assert.ok(bomb.length < 100, 'the header alone is tiny — that is the attack');
    assert.deepEqual(dimensionsOf('image/png', bomb), { width: 40000, height: 40000 });
  });

  it('fails closed when an image header yields no dimensions', () => {
    const unreachableFrame = Buffer.alloc(64, 0x11);
    unreachableFrame[0] = 0xff;
    unreachableFrame[1] = 0xd8;
    unreachableFrame[2] = 0xff;
    unreachableFrame[3] = 0xe0;
    unreachableFrame.writeUInt16BE(0xfffd, 4);

    assert.ok(matchesSignature('image/jpeg', unreachableFrame), 'the signature is valid');
    assert.deepEqual(inspect('image/jpeg', unreachableFrame), {
      ok: false,
      reason: 'DIMENSIONS_UNREADABLE',
    });
  });

  it('carries no dimensions for formats it never parses', () => {
    assert.deepEqual(dimensionsOf('application/pdf', Buffer.from('%PDF-1.7')), null);
    assert.equal(hasEnforceableDimensions('application/pdf'), false);
    assert.equal(hasEnforceableDimensions('video/mp4'), false);
  });

  it('knows which types it enforces dimensions for', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      assert.ok(hasEnforceableDimensions(type), type);
    }
  });
});
