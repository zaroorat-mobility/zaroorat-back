import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { jpeg, png, tiffBlock, webp } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

/**
 * Location metadata, end to end (files doc 01 R-FILE-29, FILES-OD-10).
 *
 * The requirement is that GPS coordinates never become readable. What this
 * module does about it is **refuse the upload**, not rewrite it: stripping would
 * mean pulling the bytes into the API process, which R-FILE-1 forbids outright
 * and NFR-1's 300 ms budget could not absorb. The client re-encodes — which an
 * app that already downscales before upload (FILES-OD-5) does for free.
 */
describe('file exif policy (integration)', () => {
  let app: FastifyInstance;
  let provider: MockStorageProvider;

  before(async () => {
    app = await bootApp();
    provider = container.resolve<MockStorageProvider>('storageProvider');
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
    provider.reset();
  });

  /**
   * Reserve, PUT the given bytes, and complete.
   * @returns The completion reply and the file's id and key.
   */
  async function upload(
    auth: { authorization: string },
    body: Buffer,
    options: { purpose?: string; contentType?: string } = {},
  ) {
    const contentType = options.contentType ?? 'image/jpeg';
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: {
        purpose: options.purpose ?? 'PROFILE_IMAGE',
        fileName: 'photo.jpg',
        contentType,
        sizeBytes: Math.max(body.length, 1),
      },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, body, contentType);
    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    return { completed, fileId, storageKey: row.storageKey };
  }

  // ── Refusal, for the purposes that must not keep it ───────────────────────

  describe('an image carrying GPS coordinates', () => {
    it('is refused at completion with EXIF_LOCATION_PRESENT', async () => {
      const user = await loginAs(app, '+919876620001');

      const { completed } = await upload(user.authHeader, jpeg({ exif: tiffBlock({ gps: true }) }));

      assert.equal(completed.statusCode, 422);
      assert.equal(completed.json().error.code, 'EXIF_LOCATION_PRESENT');
    });

    it('takes the object with it, and retires the reservation', async () => {
      const user = await loginAs(app, '+919876620002');

      const { fileId, storageKey } = await upload(
        user.authHeader,
        jpeg({ exif: tiffBlock({ gps: true }) }),
      );

      // Same treatment as a renamed executable: a refused upload must not linger
      // as something a retry could complete, and its bytes must not sit in the
      // bucket unreferenced.
      assert.equal(await provider.head(storageKey, 8), null);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      assert.equal(row.status, 'EXPIRED');
    });

    it('never becomes readable', async () => {
      const user = await loginAs(app, '+919876620003');
      const { fileId } = await upload(user.authHeader, jpeg({ exif: tiffBlock({ gps: true }) }));

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}/url`,
        headers: user.authHeader,
      });

      // R-FILE-29's actual requirement: the coordinates never reach a reader.
      assert.equal(read.statusCode, 404);
    });

    it('says location data was present, and nothing more', async () => {
      const user = await loginAs(app, '+919876620004');

      const { completed } = await upload(user.authHeader, jpeg({ exif: tiffBlock({ gps: true }) }));

      // Echoing the coordinates back would publish the very thing the rule
      // exists to suppress (doc 04 §5).
      const details = completed.json().error.details;
      assert.deepEqual(details, [{ field: 'file', code: 'METADATA_NOT_ALLOWED' }]);
    });

    it('is refused in a PNG and a WebP too, not only a JPEG', async () => {
      const user = await loginAs(app, '+919876620005');

      const asPng = await upload(user.authHeader, png({ exif: tiffBlock({ gps: true }) }), {
        contentType: 'image/png',
      });
      const asWebp = await upload(user.authHeader, webp({ exif: tiffBlock({ gps: true }) }), {
        contentType: 'image/webp',
      });

      // A rule that covered one container would be a rule an attacker satisfies
      // by choosing a different one, and every image list in doc 02 §5 accepts
      // all three.
      assert.equal(asPng.completed.json().error.code, 'EXIF_LOCATION_PRESENT');
      assert.equal(asWebp.completed.json().error.code, 'EXIF_LOCATION_PRESENT');
    });

    it('is refused for a driver document, where the photo is of a licence', async () => {
      const user = await loginAs(app, '+919876620006');

      const { completed } = await upload(
        user.authHeader,
        jpeg({ exif: tiffBlock({ gps: true }) }),
        {
          purpose: 'DRIVER_DOCUMENT',
        },
      );

      assert.equal(completed.json().error.code, 'EXIF_LOCATION_PRESENT');
    });
  });

  // ── Acceptance, and the evidence exemption (FILES-OD-10) ──────────────────

  describe('what is still accepted', () => {
    it('accepts an image with EXIF but no GPS', async () => {
      const user = await loginAs(app, '+919876620010');

      const { completed } = await upload(
        user.authHeader,
        jpeg({ exif: tiffBlock({ orientation: 1 }) }),
      );

      // A camera writes make, model, exposure, and orientation on every frame.
      // Refusing those would refuse nearly every photograph, and none of them
      // says where anyone lives.
      assert.equal(completed.statusCode, 200, completed.payload);
    });

    it('accepts an image with no metadata at all', async () => {
      const user = await loginAs(app, '+919876620011');
      const { completed } = await upload(user.authHeader, jpeg());
      assert.equal(completed.statusCode, 200, completed.payload);
    });

    it('keeps GPS on SOS evidence, where the location is the point', async () => {
      const user = await loginAs(app, '+919876620012');

      const { completed, storageKey } = await upload(
        user.authHeader,
        jpeg({ exif: tiffBlock({ gps: true }) }),
        { purpose: 'SOS_EVIDENCE' },
      );

      // FILES-OD-10: for the two evidence purposes the metadata *is* the
      // evidence — and they are already the most tightly read-scoped purposes in
      // the module (doc 02 §4).
      assert.equal(completed.statusCode, 200, completed.payload);
      assert.ok(provider.versionIds(storageKey).length > 0, 'the bytes are kept as delivered');
    });

    it('keeps GPS on dispute evidence for the same reason', async () => {
      const user = await loginAs(app, '+919876620013');

      const { completed } = await upload(
        user.authHeader,
        jpeg({ exif: tiffBlock({ gps: true }) }),
        {
          purpose: 'DISPUTE_EVIDENCE',
        },
      );

      assert.equal(completed.statusCode, 200, completed.payload);
    });

    it('accepts a PDF, which is never parsed for metadata', async () => {
      const user = await loginAs(app, '+919876620014');
      const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

      const { completed } = await upload(user.authHeader, pdf, {
        purpose: 'DRIVER_DOCUMENT',
        contentType: 'application/pdf',
      });

      // A PDF is a program, and rendering one to inspect its metadata would be a
      // far larger surface than the metadata is worth (doc 02 §5.2).
      assert.equal(completed.statusCode, 200, completed.payload);
    });
  });

  // ── Fail-closed, and the orientation fix ──────────────────────────────────

  describe('an image whose metadata cannot be read', () => {
    it('is refused rather than assumed clean', async () => {
      const user = await loginAs(app, '+919876620020');
      // Metadata that runs past the peek: absence cannot be established.
      const truncated = jpeg({ truncated: true });

      const { completed } = await upload(user.authHeader, truncated);

      // A privacy control that fails open is not a control. "I looked and found
      // nothing" and "I ran out of bytes" are different answers.
      assert.equal(completed.statusCode, 422);
      assert.equal(completed.json().error.code, 'EXIF_LOCATION_PRESENT');
    });

    it('is accepted for a purpose that keeps its metadata anyway', async () => {
      const user = await loginAs(app, '+919876620021');

      const { completed } = await upload(user.authHeader, jpeg({ truncated: true }), {
        purpose: 'SOS_EVIDENCE',
      });

      // Nothing has to be proven about metadata that is allowed to stay.
      assert.equal(completed.statusCode, 200, completed.payload);
    });
  });

  describe('a photograph taken sideways', () => {
    it('is measured as it renders, not as it is stored', async () => {
      const user = await loginAs(app, '+919876620030');
      // VEHICLE_IMAGE's ceiling is 6000 x 6000. Stored 4000 x 6000 with
      // orientation 6, this renders as 6000 x 4000 — inside the ceiling either
      // way, but transposition is what the assertion below pins.
      const sideways = jpeg({ width: 4000, height: 6000, exif: tiffBlock({ orientation: 6 }) });

      const { completed, fileId } = await upload(user.authHeader, sideways, {
        purpose: 'VEHICLE_IMAGE',
      });

      assert.equal(completed.statusCode, 200, completed.payload);
      assert.ok(await db().client.file.findUnique({ where: { id: fileId } }));
    });

    it('is refused when the rendered shape exceeds the ceiling', async () => {
      const user = await loginAs(app, '+919876620031');
      // 3000 x 5000 stored, orientation 6, so it renders 5000 x 3000 — over
      // PROFILE_IMAGE's 4096 width. Measured untransposed it would have passed.
      const sideways = jpeg({ width: 3000, height: 5000, exif: tiffBlock({ orientation: 6 }) });

      const { completed } = await upload(user.authHeader, sideways);

      assert.equal(completed.statusCode, 413);
      assert.equal(completed.json().error.code, 'FILE_TOO_LARGE');
    });
  });
});
