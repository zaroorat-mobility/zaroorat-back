import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { jpeg, png, tiffBlock, webp } from '../helpers/image-fixtures.js';
import type { MockStorageProvider } from '../../src/modules/files/utils/storage/mock.provider.js';

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

  describe('an image carrying GPS coordinates', () => {
    it('is refused at completion with EXIF_LOCATION_PRESENT', async () => {
      const user = await loginAs(app, '+919876620001');

      const { completed } = await upload(user.authHeader, jpeg({ exif: tiffBlock({ gps: true }) }));

      assert.equal(completed.statusCode, 422);
      assert.equal(completed.json().error.code, 'EXIF_LOCATION_PRESENT');
    });

    it('takes the object with it, and records the refusal', async () => {
      const user = await loginAs(app, '+919876620002');

      const { fileId, storageKey } = await upload(
        user.authHeader,
        jpeg({ exif: tiffBlock({ gps: true }) }),
      );

      assert.equal(await provider.head(storageKey, 8), null);
      const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
      // REJECTED, not EXPIRED: an image refused for carrying GPS data and a
      // reservation nobody ever uploaded to are different events, and the row is
      // the only durable trace of which one happened.
      assert.equal(row.status, 'REJECTED');
      assert.equal(row.rejectedReason, 'EXIF_LOCATION_PRESENT');
    });

    it('never becomes readable', async () => {
      const user = await loginAs(app, '+919876620003');
      const { fileId } = await upload(user.authHeader, jpeg({ exif: tiffBlock({ gps: true }) }));

      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}/url`,
        headers: user.authHeader,
      });

      assert.equal(read.statusCode, 404);
    });

    it('says location data was present, and nothing more', async () => {
      const user = await loginAs(app, '+919876620004');

      const { completed } = await upload(user.authHeader, jpeg({ exif: tiffBlock({ gps: true }) }));

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

  describe('what is still accepted', () => {
    it('accepts an image with EXIF but no GPS', async () => {
      const user = await loginAs(app, '+919876620010');

      const { completed } = await upload(
        user.authHeader,
        jpeg({ exif: tiffBlock({ orientation: 1 }) }),
      );

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

      assert.equal(completed.statusCode, 200, completed.payload);
    });
  });

  describe('an image whose metadata cannot be read', () => {
    it('is refused rather than assumed clean', async () => {
      const user = await loginAs(app, '+919876620020');

      const truncated = jpeg({ truncated: true });

      const { completed } = await upload(user.authHeader, truncated);

      assert.equal(completed.statusCode, 422);
      assert.equal(completed.json().error.code, 'EXIF_LOCATION_PRESENT');
    });

    it('is accepted for a purpose that keeps its metadata anyway', async () => {
      const user = await loginAs(app, '+919876620021');

      const { completed } = await upload(user.authHeader, jpeg({ truncated: true }), {
        purpose: 'SOS_EVIDENCE',
      });

      assert.equal(completed.statusCode, 200, completed.payload);
    });
  });

  describe('a photograph taken sideways', () => {
    it('is measured as it renders, not as it is stored', async () => {
      const user = await loginAs(app, '+919876620030');

      const sideways = jpeg({ width: 4000, height: 6000, exif: tiffBlock({ orientation: 6 }) });

      const { completed, fileId } = await upload(user.authHeader, sideways, {
        purpose: 'VEHICLE_IMAGE',
      });

      assert.equal(completed.statusCode, 200, completed.payload);
      assert.ok(await db().client.file.findUnique({ where: { id: fileId } }));
    });

    it('is refused when the rendered shape exceeds the ceiling', async () => {
      const user = await loginAs(app, '+919876620031');

      const sideways = jpeg({ width: 3000, height: 5000, exif: tiffBlock({ orientation: 6 }) });

      const { completed } = await upload(user.authHeader, sideways);

      assert.equal(completed.statusCode, 413);
      assert.equal(completed.json().error.code, 'FILE_TOO_LARGE');
    });
  });
});
