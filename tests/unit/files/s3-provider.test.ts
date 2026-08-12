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
import { createStorageProvider } from '../../../src/modules/files/config/storage.config.js';
import type { StorageConfig } from '../../../src/modules/files/config/storage.config.js';

function configFor(overrides: Partial<StorageConfig> = {}): StorageConfig {
  return {
    provider: 's3',
    bucket: 'zaroorat-private',
    quarantineBucket: null,
    scanner: 'disabled',
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

const FIXED_NOW = new Date('2026-08-03T10:00:00.000Z');

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

function sdkError(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(httpStatusCode != null ? { $metadata: { httpStatusCode } } : {}),
  });
}

describe('S3 storage provider (unit)', () => {
  it('is named "s3" — the value persisted in files.storage_provider', () => {
    const { provider } = withFakeClient(async () => ({}));
    assert.equal(provider.name, 's3');
  });

  it('refuses to construct without a bucket', () => {
    assert.throws(
      () => new S3StorageProvider(configFor({ bucket: null })),
      /STORAGE_BUCKET is required/,
    );
  });

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

  describe('head', () => {
    it('reads the total size from Content-Range, not from the range it fetched', async () => {
      const { provider } = withFakeClient(async () => ({
        ContentRange: 'bytes 0-511/842114',
        ContentType: 'image/jpeg',
        Body: { transformToByteArray: async () => new Uint8Array([0xff, 0xd8, 0xff]) },
      }));

      const head = await provider.head('dd/2026/08/abc.jpg', 512);

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

      const health = await provider.health();
      assert.equal(health.reachable, false);
    });
  });

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
      assert.throws(
        () => createStorageProvider(configFor({ bucket: null })),
        /STORAGE_BUCKET is required/,
      );
    });
  });

  it('logs nothing at all — FILE-INV-2 applies inside the provider', () => {
    const source = readFileSync('src/modules/files/providers/s3.provider.ts', 'utf8');

    assert.equal(source.includes('logger'), false);
    assert.equal(source.includes('console.'), false);
  });
});
