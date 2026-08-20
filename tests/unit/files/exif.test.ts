import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspect } from '../../../src/modules/files/utils/inspection/content-inspector.js';
import { jpeg, png, tiffBlock, webp, webpLossy } from '../../helpers/image-fixtures.js';

function locationOf(contentType: string, header: Buffer): string {
  const result = inspect(contentType, header);
  assert.equal(result.ok, true, `header rejected: ${result.ok ? '' : result.reason}`);
  return result.ok ? result.location : 'n/a';
}

describe('EXIF inspection (unit)', () => {
  describe('finding location data', () => {
    it('reports a JPEG carrying a GPS directory', () => {
      assert.equal(locationOf('image/jpeg', jpeg({ exif: tiffBlock({ gps: true }) })), 'PRESENT');
    });

    it('reports a JPEG with EXIF but no GPS as clean', () => {
      assert.equal(
        locationOf('image/jpeg', jpeg({ exif: tiffBlock({ orientation: 1 }) })),
        'ABSENT',
      );
    });

    it('reports a JPEG with no EXIF segment at all as clean', () => {
      assert.equal(locationOf('image/jpeg', jpeg()), 'ABSENT');
    });

    it('reads a big-endian block as readily as a little-endian one', () => {
      assert.equal(
        locationOf('image/jpeg', jpeg({ exif: tiffBlock({ gps: true, bigEndian: true }) })),
        'PRESENT',
      );
    });

    it('reports a PNG eXIf chunk carrying GPS', () => {
      assert.equal(locationOf('image/png', png({ exif: tiffBlock({ gps: true }) })), 'PRESENT');
    });

    it('reports a PNG with no eXIf chunk as clean', () => {
      assert.equal(locationOf('image/png', png()), 'ABSENT');
    });

    it('reports a WebP EXIF chunk carrying GPS', () => {
      assert.equal(locationOf('image/webp', webp({ exif: tiffBlock({ gps: true }) })), 'PRESENT');
    });

    it('treats a plain lossy WebP as clean — it has nowhere to put metadata', () => {
      assert.equal(locationOf('image/webp', webpLossy()), 'ABSENT');
    });

    it('says UNKNOWN, not ABSENT, when the metadata runs past the slice', () => {
      assert.equal(locationOf('image/jpeg', jpeg({ truncated: true })), 'UNKNOWN');
    });

    it('says UNKNOWN when an APP1 segment is cut off mid-block', () => {
      const header = Buffer.concat([jpeg().subarray(0, 21), Buffer.from([0xff, 0xe1, 0x02, 0x00])]);

      assert.equal(locationOf('image/jpeg', header), 'UNKNOWN');
    });

    it('never reports location for a format that carries none', () => {
      const pdf = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(64)]);
      assert.equal(locationOf('application/pdf', pdf), 'ABSENT');
    });
  });

  describe('orientation, applied before the pixel ceiling is checked', () => {
    it('transposes a frame stored sideways', () => {
      const header = jpeg({ width: 4000, height: 6000, exif: tiffBlock({ orientation: 6 }) });

      const result = inspect('image/jpeg', header);

      assert.deepEqual(result.ok && result.dimensions, { width: 6000, height: 4000 });
    });

    it('leaves an upright frame alone', () => {
      const header = jpeg({ width: 4000, height: 6000, exif: tiffBlock({ orientation: 1 }) });

      const result = inspect('image/jpeg', header);

      assert.deepEqual(result.ok && result.dimensions, { width: 4000, height: 6000 });
    });

    it('leaves a mirrored-but-upright frame alone', () => {
      const header = jpeg({ width: 4000, height: 6000, exif: tiffBlock({ orientation: 2 }) });

      const result = inspect('image/jpeg', header);

      assert.deepEqual(result.ok && result.dimensions, { width: 4000, height: 6000 });
    });

    it('transposes for every quarter-turn value, and no other', () => {
      for (const orientation of [5, 6, 7, 8]) {
        const result = inspect('image/jpeg', jpeg({ exif: tiffBlock({ orientation }) }));
        assert.deepEqual(
          result.ok && result.dimensions,
          { width: 600, height: 800 },
          `orientation ${orientation}`,
        );
      }
      for (const orientation of [1, 2, 3, 4]) {
        const result = inspect('image/jpeg', jpeg({ exif: tiffBlock({ orientation }) }));
        assert.deepEqual(
          result.ok && result.dimensions,
          { width: 800, height: 600 },
          `orientation ${orientation}`,
        );
      }
    });

    it('leaves dimensions alone when no orientation tag is present', () => {
      const result = inspect('image/jpeg', jpeg({ width: 800, height: 600 }));
      assert.deepEqual(result.ok && result.dimensions, { width: 800, height: 600 });
    });
  });

  describe('the walk stays inside the buffer', () => {
    it('refuses a TIFF block whose IFD offset points past the end', () => {
      const block = tiffBlock({ gps: true });
      block.writeUInt32LE(0xffff, 4);

      assert.equal(locationOf('image/jpeg', jpeg({ exif: block })), 'UNKNOWN');
    });

    it('refuses a block claiming more entries than it holds', () => {
      const block = tiffBlock({ gps: true });
      block.writeUInt16LE(500, 8);

      assert.equal(locationOf('image/jpeg', jpeg({ exif: block })), 'UNKNOWN');
    });

    it('refuses a block with neither byte-order mark', () => {
      const block = tiffBlock({ gps: true });
      block.write('XX', 0, 'ascii');

      assert.equal(locationOf('image/jpeg', jpeg({ exif: block })), 'UNKNOWN');
    });
  });
});
