import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import { S3StorageProvider } from '../../../src/modules/files/providers/s3.provider.js';
import { StorageError } from '../../../src/modules/files/providers/storage.provider.js';
import { MockStorageProvider } from '../../../src/modules/files/providers/mock.provider.js';
import { createStorageProvider } from '../../../src/modules/files/storage.config.js';
import type { StorageConfig } from '../../../src/modules/files/storage.config.js';

/** A complete config, overridable per test. Credentials are fake and unused. */
function configFor(overrides: Partial<StorageConfig> = {}): StorageConfig {
  return {
    provider: 's3',
    bucket: 'zaroorat-private',
    region: 'ap-south-1',
    endpoint: null,
    forcePathStyle: false,
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' },
    serverSideEncryption: 'AES256',
    kmsKeyId: null,
    uploadUrlTtlSeconds: 900,
    peekBytes: 512,
    imagePeekBytes: 131072,
    requestTimeoutMs: 5000,
    maxRetries: 2,
    ...overrides,
  };
}

/** A fixed clock, so expiry arithmetic is asserted rather than approximated. */
const FIXED_NOW = new Date('2026-08-03T10:00:00.000Z');

/** A provider whose SDK client is a stub — for everything that would do I/O. */
function withFakeClient(
  send: (command: unknown) => Promise<unknown>,
  overrides: Partial<StorageConfig> = {},
): { provider: S3StorageProvider; sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    send: (command: unknown) => {
      sent.push(command);
      return send(command);
    },
  } as unknown as S3Client;
  return {
    provider: new S3StorageProvider(configFor(overrides), client, () => FIXED_NOW),
    sent,
  };
}

/** An error shaped the way the AWS SDK shapes them. */
function sdkError(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(httpStatusCode != null ? { $metadata: { httpStatusCode } } : {}),
  });
}

/**
 * The S3 provider (files doc 01 §12 phase 5, doc 07).
 *
 * **Every test here runs with no bucket and no network.** Presigning is local
 * crypto, so the signature tests exercise the real signer; everything that would
 * perform I/O runs against a stubbed client. What is deliberately *not* covered
 * is that AWS honours the signatures we produce — that is AWS's contract, and
 * testing it in CI would be testing AWS (doc 06 §8).
 */
describe('S3 storage provider (unit)', () => {
  it('is named "s3" — the value persisted in files.storage_provider', () => {
    const { provider } = withFakeClient(async () => ({}));
    assert.equal(provider.name, 's3');
  });

  it('refuses to construct without a bucket', () => {
    // Doc 08 §7: a files module with no bucket has no work it can do, and
    // failing at boot turns a subtle production outage into a deploy failure.
    assert.throws(
      () => new S3StorageProvider(configFor({ bucket: null })),
      /STORAGE_BUCKET is required/,
    );
  });

  // ── Signing (R-FILE-2, R-FILE-12) ──────────────────────────────────────────

  describe('signUpload', () => {
    it('binds the key, the method, and an explicit expiry', async () => {
      const provider = new S3StorageProvider(configFor(), undefined, () => FIXED_NOW);

      const signed = await provider.signUpload({
        key: 'dd/2026/08/abc.jpg',
        contentType: 'image/jpeg',
        maxBytes: 10 * 1024 * 1024,
        ttlSeconds: 900,
      });
      const url = new URL(signed.url);

      assert.equal(signed.method, 'PUT');
      assert.equal(url.hostname, 'zaroorat-private.s3.ap-south-1.amazonaws.com');
      assert.equal(url.pathname, '/dd/2026/08/abc.jpg');
      assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
      assert.ok(url.searchParams.get('X-Amz-Signature'), 'it is actually signed');
      assert.equal(signed.expiresAt.getTime(), FIXED_NOW.getTime() + 900_000);
    });

    it('signs content-type, which the presigner would otherwise leave unbound', async () => {
      const provider = new S3StorageProvider(configFor(), undefined, () => FIXED_NOW);

      const signed = await provider.signUpload({
        key: 'dd/2026/08/abc.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1024,
        ttlSeconds: 300,
      });
      const signedHeaders = new URL(signed.url).searchParams.get('X-Amz-SignedHeaders') ?? '';

      // The S3 presigner adds `content-type` to unsignableHeaders by default,
      // which would leave a permission that writes *any* type to the key.
      // R-FILE-2 requires one content-type, so it is signed explicitly.
      assert.ok(signedHeaders.split(';').includes('content-type'), signedHeaders);
      assert.equal(signed.headers['Content-Type'], 'image/jpeg');
    });

    it('returns the encryption headers the client must send back', async () => {
      const provider = new S3StorageProvider(
        configFor({ serverSideEncryption: 'aws:kms', kmsKeyId: 'key-123' }),
        undefined,
        () => FIXED_NOW,
      );

      const signed = await provider.signUpload({
        key: 'dd/2026/08/abc.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1024,
        ttlSeconds: 300,
      });
      const signedHeaders = new URL(signed.url).searchParams.get('X-Amz-SignedHeaders') ?? '';

      // The presigner forces every `x-amz-server-side-encryption*` header
      // unhoistable, so they stay signed headers rather than query parameters.
      // A client that does not send them back gets a signature mismatch on every
      // upload — which is why they are in `headers` (doc 07 §2.1).
      assert.equal(signed.headers['x-amz-server-side-encryption'], 'aws:kms');
      assert.equal(signed.headers['x-amz-server-side-encryption-aws-kms-key-id'], 'key-123');
      assert.ok(signedHeaders.includes('x-amz-server-side-encryption'), signedHeaders);
    });

    it('hands a declared checksum to S3 as base64, bound as a header', async () => {
      const hex = 'a'.repeat(64);
      const provider = new S3StorageProvider(configFor(), undefined, () => FIXED_NOW);

      const signed = await provider.signUpload({
        key: 'dd/2026/08/abc.jpg',
        contentType: 'image/jpeg',
        maxBytes: 1024,
        ttlSeconds: 300,
        checksumSha256: hex,
      });

      assert.equal(
        signed.headers['x-amz-checksum-sha256'],
        Buffer.from(hex, 'hex').toString('base64'),
      );
      // Kept out of the query string on purpose: as a parameter S3 would not
      // enforce it, and a binding that is not enforced is worse than none.
      const signedHeaders = new URL(signed.url).searchParams.get('X-Amz-SignedHeaders') ?? '';
      assert.ok(signedHeaders.includes('x-amz-checksum-sha256'), signedHeaders);
      assert.equal(new URL(signed.url).searchParams.has('x-amz-checksum-sha256'), false);
    });

    it('addresses a MinIO-style endpoint by path, with the same code', async () => {
      const provider = new S3StorageProvider(
        configFor({ endpoint: 'http://localhost:9000', forcePathStyle: true }),
        undefined,
        () => FIXED_NOW,
      );

      const signed = await provider.signUpload({
        key: 'pi/2026/08/abc.png',
        contentType: 'image/png',
        maxBytes: 1024,
        ttlSeconds: 300,
      });
      const url = new URL(signed.url);

      // FILES-OD-12: MinIO, R2, Spaces, and Ceph are this class with a different
      // endpoint. Four vendors, one implementation.
      assert.equal(url.host, 'localhost:9000');
      assert.equal(url.pathname, '/zaroorat-private/pi/2026/08/abc.png');
    });
  });

  describe('signDownload', () => {
    it('binds the disposition and content-type into the signature', async () => {
      const provider = new S3StorageProvider(configFor(), undefined, () => FIXED_NOW);

      const signed = await provider.signDownload({
        key: 'dd/2026/08/abc.jpg',
        ttlSeconds: 300,
        contentType: 'image/jpeg',
        disposition: 'attachment',
        fileName: 'licence.jpg',
      });
      const url = new URL(signed.url);

      // A holder cannot re-point the response headers: changing either
      // parameter invalidates the signature.
      assert.equal(
        url.searchParams.get('response-content-disposition'),
        'attachment; filename="licence.jpg"',
      );
      assert.equal(url.searchParams.get('response-content-type'), 'image/jpeg');
      assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
      assert.equal(signed.expiresAt.getTime(), FIXED_NOW.getTime() + 300_000);
    });

    it('mints a different URL every call — nothing is cached (R-FILE-12)', async () => {
      let tick = 0;
      const provider = new S3StorageProvider(
        configFor(),
        undefined,
        () => new Date(FIXED_NOW.getTime() + (tick += 1000)),
      );
      const input = {
        key: 'dd/2026/08/abc.jpg',
        ttlSeconds: 300,
        contentType: 'image/jpeg',
        disposition: 'inline' as const,
        fileName: 'a.jpg',
      };

      const first = await provider.signDownload(input);
      const second = await provider.signDownload(input);

      assert.notEqual(first.expiresAt.getTime(), second.expiresAt.getTime());
    });
  });

  // ── head: one round trip (doc 07 §2) ───────────────────────────────────────

  describe('head', () => {
    it('reads the total size from Content-Range, not from the range it fetched', async () => {
      const { provider } = withFakeClient(async () => ({
        ContentRange: 'bytes 0-511/842114',
        ContentType: 'image/jpeg',
        Body: { transformToByteArray: async () => new Uint8Array([0xff, 0xd8, 0xff]) },
      }));

      const head = await provider.head('dd/2026/08/abc.jpg', 512);

      // The whole reason this is one call and not two: a ranged GET already
      // carries the full length, so HeadObject would buy only latency.
      assert.equal(head?.sizeBytes, 842114);
      assert.deepEqual([...(head?.peek ?? [])], [0xff, 0xd8, 0xff]);
      assert.equal(head?.contentType, 'image/jpeg');
    });

    it('re-encodes the checksum from S3’s base64 into the hex the client declared', async () => {
      const hex = 'b'.repeat(64);
      const { provider } = withFakeClient(async () => ({
        ContentRange: 'bytes 0-2/3',
        ChecksumSHA256: Buffer.from(hex, 'hex').toString('base64'),
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
      }));

      const head = await provider.head('k', 512);

      // Without this every checksum would mismatch, and CHECKSUM_MISMATCH would
      // tell users to re-upload a file that was never corrupt.
      assert.equal(head?.checksumSha256, hex);
    });

    it('reports no checksum when S3 holds none', async () => {
      const { provider } = withFakeClient(async () => ({
        ContentRange: 'bytes 0-2/3',
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
      }));

      assert.equal((await provider.head('k', 512))?.checksumSha256, null);
    });

    it('returns null for an absent object — that is an answer, not a failure', async () => {
      const { provider } = withFakeClient(async () => {
        throw sdkError('NoSuchKey', 404);
      });

      // It becomes `409 UPLOAD_NOT_FOUND` and the row stays PENDING so the
      // client can re-PUT and retry (doc 07 §4).
      assert.equal(await provider.head('k', 512), null);
    });

    it('wraps a real failure as a retryable StorageError', async () => {
      const { provider } = withFakeClient(async () => {
        throw sdkError('InternalError', 500);
      });

      await assert.rejects(
        () => provider.head('k', 512),
        (err: unknown) =>
          err instanceof StorageError && err.operation === 'head' && err.retryable === true,
      );
    });
  });

  // ── delete vs erase — the versioning trap (doc 08 §2.2) ────────────────────

  describe('delete', () => {
    it('treats an absent object as success (R-FILE-23)', async () => {
      const { provider } = withFakeClient(async () => {
        throw sdkError('NoSuchKey', 404);
      });

      await assert.doesNotReject(() => provider.delete('k'));
    });

    it('wraps anything else', async () => {
      const { provider } = withFakeClient(async () => {
        throw sdkError('AccessDenied', 403);
      });

      await assert.rejects(
        () => provider.delete('k'),
        (err: unknown) =>
          err instanceof StorageError && err.operation === 'delete' && err.retryable === false,
      );
    });
  });

  describe('erase', () => {
    it('removes every version and every delete marker', async () => {
      const { provider, sent } = withFakeClient(async (command) => {
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: [
              { Key: 'k', VersionId: 'v1' },
              { Key: 'k', VersionId: 'v2' },
            ],
            DeleteMarkers: [{ Key: 'k', VersionId: 'm1' }],
            IsTruncated: false,
          };
        }
        return {};
      });

      await provider.erase('k');

      // A plain delete would leave the bytes retrievable by anyone who can name
      // a version id, while `file.erased` recorded that they were gone — an
      // erasure obligation logged as honoured and not performed.
      const deletion = sent.find((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
      assert.deepEqual(deletion.input.Delete?.Objects?.map((o) => o.VersionId).sort(), [
        'm1',
        'v1',
        'v2',
      ]);
    });

    it('never touches a longer key that merely shares the prefix', async () => {
      const { provider, sent } = withFakeClient(async (command) => {
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: [
              { Key: 'k', VersionId: 'v1' },
              { Key: 'k-other', VersionId: 'x1' },
            ],
            IsTruncated: false,
          };
        }
        return {};
      });

      await provider.erase('k');

      // ListObjectVersions takes a prefix, not a key. Erasing what it returns
      // unfiltered would destroy unrelated files.
      const deletion = sent.find((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
      assert.deepEqual(deletion.input.Delete?.Objects, [{ Key: 'k', VersionId: 'v1' }]);
    });

    it('follows pagination to the end', async () => {
      let page = 0;
      const { provider, sent } = withFakeClient(async (command) => {
        if (command instanceof ListObjectVersionsCommand) {
          page += 1;
          return page === 1
            ? {
                Versions: [{ Key: 'k', VersionId: 'v1' }],
                IsTruncated: true,
                NextKeyMarker: 'k',
                NextVersionIdMarker: 'v1',
              }
            : { Versions: [{ Key: 'k', VersionId: 'v2' }], IsTruncated: false };
        }
        return {};
      });

      await provider.erase('k');

      // Stopping at the first page would leave older versions alive on any
      // object written more than a thousand times.
      assert.equal(sent.filter((c) => c instanceof ListObjectVersionsCommand).length, 2);
      assert.equal(sent.filter((c) => c instanceof DeleteObjectsCommand).length, 2);
    });

    it('is a no-op when nothing is there', async () => {
      const { provider, sent } = withFakeClient(async () => ({ IsTruncated: false }));

      await provider.erase('k');

      assert.equal(sent.filter((c) => c instanceof DeleteObjectsCommand).length, 0);
    });
  });

  describe('archive', () => {
    it('changes the storage class without deleting anything (R-FILE-21)', async () => {
      const { provider, sent } = withFakeClient(async () => ({}));

      await provider.archive('dd/2026/08/abc.pdf');

      const copy = sent[0] as CopyObjectCommand;
      assert.ok(copy instanceof CopyObjectCommand, 'archive is a copy, never a delete');
      assert.equal(copy.input.StorageClass, 'GLACIER_IR');
      assert.equal(copy.input.MetadataDirective, 'COPY');
      assert.equal(copy.input.Key, 'dd/2026/08/abc.pdf');
    });
  });

  // ── Health, which must never throw (doc 07 §2) ─────────────────────────────

  describe('health', () => {
    it('reports a reachable bucket', async () => {
      const { provider } = withFakeClient(async () => ({}));

      assert.deepEqual(await provider.health(), {
        reachable: true,
        bucketExists: true,
        credentialsValid: true,
        latencyMs: 0,
      });
    });

    it('distinguishes bad credentials from a missing bucket', async () => {
      const forbidden = withFakeClient(async () => {
        throw sdkError('AccessDenied', 403);
      });
      const missing = withFakeClient(async () => {
        throw sdkError('NotFound', 404);
      });

      const denied = await forbidden.provider.health();
      const absent = await missing.provider.health();

      // The flags exist so an operator can tell "the key was rotated" from "the
      // bucket name is wrong" without reading a stack trace.
      assert.deepEqual(
        [denied.reachable, denied.credentialsValid, denied.bucketExists],
        [true, false, true],
      );
      assert.deepEqual(
        [absent.reachable, absent.credentialsValid, absent.bucketExists],
        [true, true, false],
      );
    });

    it('reports unreachable when the service never answered', async () => {
      const { provider } = withFakeClient(async () => {
        throw sdkError('TimeoutError');
      });

      // A probe that raised could not report degradation at all.
      const health = await provider.health();
      assert.equal(health.reachable, false);
    });
  });

  // ── Error classification (doc 07 §4) ───────────────────────────────────────

  describe('retryability', () => {
    const cases: [string, number | undefined, boolean][] = [
      ['a 5xx', 503, true],
      ['throttling', 429, true],
      ['bad credentials', 403, false],
      ['a missing bucket', 404, false],
      ['a timeout with no response at all', undefined, true],
    ];

    for (const [label, status, retryable] of cases) {
      it(`classifies ${label} as ${retryable ? 'retryable' : 'not retryable'}`, async () => {
        const { provider } = withFakeClient(async () => {
          throw sdkError('Whatever', status);
        });

        // `retryable` decides the log level and the alert, not the status — both
        // reach the client as `503` (doc 04 §6, doc 09 §2.5).
        await assert.rejects(
          () => provider.archive('k'),
          (err: unknown) => err instanceof StorageError && err.retryable === retryable,
        );
      });
    }

    it('never lets a vendor error escape (doc 07 §3 rule 1)', async () => {
      const { provider } = withFakeClient(async () => {
        throw sdkError('SlowDown', 503);
      });

      await assert.rejects(
        () => provider.archive('k'),
        (err: unknown) => err instanceof StorageError && err.name === 'StorageError',
      );
    });
  });

  // ── Criterion #10: the swap is configuration ───────────────────────────────

  describe('the provider factory', () => {
    it('selects s3 from configuration alone', () => {
      assert.ok(createStorageProvider(configFor()) instanceof S3StorageProvider);
    });

    it('selects the mock when configured for it', () => {
      assert.ok(
        createStorageProvider(configFor({ provider: 'mock' })) instanceof MockStorageProvider,
      );
    });

    it('refuses s3 without a bucket rather than falling back to the mock', () => {
      // Falling back would put a production deploy on an in-memory store and
      // lose every uploaded object at the next restart (doc 08 §7).
      assert.throws(
        () => createStorageProvider(configFor({ bucket: null })),
        /STORAGE_BUCKET is required/,
      );
    });
  });

  it('logs nothing at all — FILE-INV-2 applies inside the provider', () => {
    const source = readFileSync('src/modules/files/providers/s3.provider.ts', 'utf8');

    // Doc 07 §3 rule 4. A key or a signed URL in a debug line is the same
    // disclosure as one in a response body, and harder to notice.
    assert.equal(source.includes('logger'), false);
    assert.equal(source.includes('console.'), false);
  });
});
