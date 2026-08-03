import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspect } from '../../../src/modules/files/content-inspector.js';
import { jpeg, png, tiffBlock, webp, webpLossy } from '../../helpers/image-fixtures.js';

/** The location verdict for a header, asserting the header itself was accepted. */
function locationOf(contentType: string, header: Buffer): string {
  const result = inspect(contentType, header);
  assert.equal(result.ok, true, `header rejected: ${result.ok ? '' : result.reason}`);
  return result.ok ? result.location : 'n/a';
}

/**
 * EXIF location and orientation (files doc 01 R-FILE-29, doc 02 §5.2).
 *
 * A phone JPEG carries the coordinates it was taken at. An avatar that discloses
 * the rider's home address is a privacy failure no access control catches, and
 * it is invisible to every check that came before this one — the bytes are a
 * perfectly valid image of a perfectly reasonable size.
 *
 * Everything here reads **container metadata**: a JPEG `APP1`, a PNG `eXIf`
 * chunk, a WebP `EXIF` chunk. None of it decodes a pixel, which is what lets the
 * check ride the header slice `head()` already fetched.
 */
describe('EXIF inspection (unit)', () => {
  describe('finding location data', () => {
    it('reports a JPEG carrying a GPS directory', () => {
      assert.equal(locationOf('image/jpeg', jpeg({ exif: tiffBlock({ gps: true }) })), 'PRESENT');
    });

    it('reports a JPEG with EXIF but no GPS as clean', () => {
      // The common case worth getting right: a camera writes make, model,
      // exposure, and orientation on every frame. Refusing those would refuse
      // nearly every photograph, and none of them says where anyone lives.
      assert.equal(
        locationOf('image/jpeg', jpeg({ exif: tiffBlock({ orientation: 1 }) })),
        'ABSENT',
      );
    });

    it('reports a JPEG with no EXIF segment at all as clean', () => {
      assert.equal(locationOf('image/jpeg', jpeg()), 'ABSENT');
    });

    it('reads a big-endian block as readily as a little-endian one', () => {
      // `MM` is what most Canon and Nikon bodies write. Reading only `II` would
      // pass every photograph from half the cameras in use.
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
      // Only the extended VP8X container has chunks. Reporting UNKNOWN here
      // would refuse every ordinary WebP for a segment the format cannot hold.
      assert.equal(locationOf('image/webp', webpLossy()), 'ABSENT');
    });

    it('says UNKNOWN, not ABSENT, when the metadata runs past the slice', () => {
      // The distinction the whole verdict exists for: "I looked and found
      // nothing" and "I ran out of bytes" are different answers, and only one of
      // them is safe to treat as clean.
      assert.equal(locationOf('image/jpeg', jpeg({ truncated: true })), 'UNKNOWN');
    });

    it('says UNKNOWN when an APP1 segment is cut off mid-block', () => {
      // The frame header, then an APP1 announcing 512 bytes that are not in the
      // slice. Dimensions are readable, so this reaches the EXIF walk — which
      // must not read the segment it can only see part of.
      const header = Buffer.concat([
        jpeg().subarray(0, 21), // SOI + SOF0, without the scan marker
        Buffer.from([0xff, 0xe1, 0x02, 0x00]),
      ]);

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

      // A phone held sideways writes 4000 × 6000 and an orientation of 6; every
      // viewer shows 6000 × 4000. Measuring the stored frame against a per-axis
      // ceiling refuses the picture for a shape it does not have (doc 02 §5.2).
      assert.deepEqual(result.ok && result.dimensions, { width: 6000, height: 4000 });
    });

    it('leaves an upright frame alone', () => {
      const header = jpeg({ width: 4000, height: 6000, exif: tiffBlock({ orientation: 1 }) });

      const result = inspect('image/jpeg', header);

      assert.deepEqual(result.ok && result.dimensions, { width: 4000, height: 6000 });
    });

    it('leaves a mirrored-but-upright frame alone', () => {
      // 2–4 are flips, not quarter-turns: the axes do not swap.
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

      // A crafted offset must not send the reader anywhere; it reports that it
      // could not tell, and a purpose that strips then refuses the upload.
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
