import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FileService } from '../../../src/modules/files/services/file.service.js';
import { FileAccessService } from '../../../src/modules/files/services/file-access.service.js';
import { FileLifecycleService } from '../../../src/modules/files/services/file-lifecycle.service.js';
import { FileStorageService } from '../../../src/modules/files/services/file-storage.service.js';
import { FileUploadService } from '../../../src/modules/files/services/file-upload.service.js';
import { FileValidationService } from '../../../src/modules/files/services/file-validation.service.js';
import { FileMetrics } from '../../../src/modules/files/metrics/file.metrics.js';
import { MockStorageProvider } from '../../../src/modules/files/utils/storage/mock.provider.js';
import { STORAGE_KEY_PATTERN } from '../../../src/modules/files/utils/storage-key.js';
import { png } from '../../helpers/image-fixtures.js';
import type { StorageConfig } from '../../../src/modules/files/config/storage.config.js';

const OWNER = '0198a0b3-0000-7000-8000-000000000001';
const FILE_ID = '0198f2c1-0000-7000-8000-0000000000f1';

const storageConfig: StorageConfig = {
  provider: 'mock',
  bucket: null,
  quarantineBucket: null,
  scanner: 'disabled',
  region: 'ap-south-1',
  endpoint: null,
  forcePathStyle: false,
  credentials: null,
  serverSideEncryption: 'AES256',
  kmsKeyId: null,
  uploadUrlTtlSeconds: 900,
  peekBytes: 512,
  imagePeekBytes: 131072,
  requestTimeoutMs: 5000,
  maxRetries: 2,
};

function permissiveRedis(): never {
  return {
    rateLimit: {
      hit: async () => ({ allowed: true, current: 1, remaining: 99, retryAfterSeconds: 0 }),
    },
  } as never;
}

function makeService(overrides: {
  create?: (input: unknown) => Promise<unknown>;
  findOwned?: () => Promise<unknown>;
  markReady?: () => Promise<boolean>;
  publish?: (event: unknown, tx: unknown) => Promise<void>;
  execute?: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  provider?: MockStorageProvider;
}) {
  const provider = overrides.provider ?? new MockStorageProvider();
  const created: unknown[] = [];
  const published: { event: unknown; tx: unknown }[] = [];

  const repository = {
    create: async (input: unknown) => {
      created.push(input);
      return overrides.create ? overrides.create(input) : { ...(input as object), id: FILE_ID };
    },
    findOwned: overrides.findOwned ?? (async () => null),
    markReady: overrides.markReady ?? (async () => true),
    markExpired: async () => true,
    totalBytesForUser: async () => 0,
  };

  const eventPublisher = {
    publish: async (event: unknown, tx: unknown) => {
      published.push({ event, tx });
      if (overrides.publish) await overrides.publish(event, tx);
    },
  };

  const transactionManager = {
    execute:
      overrides.execute ??
      (async (fn: (tx: unknown) => Promise<unknown>) => fn({ marker: 'the-tx' })),
  };

  // Same collaborators as before the service split; FileService is now a
  // facade over the three services that carry the work.
  const metrics = new FileMetrics();
  const redis = permissiveRedis();
  const storage = new FileStorageService(provider, storageConfig);
  const validation = new FileValidationService();

  const service = new FileService(
    new FileUploadService(
      repository as never,
      storage,
      validation,
      storageConfig,
      transactionManager as never,
      eventPublisher as never,
      redis,
      metrics,
    ),
    new FileAccessService(
      repository as never,
      storage,
      validation,
      transactionManager as never,
      eventPublisher as never,
      redis,
      metrics,
    ),
    new FileLifecycleService(
      repository as never,
      transactionManager as never,
      eventPublisher as never,
    ),
  );

  return { service, provider, created, published };
}

describe('FileService.createUpload — ordering (R-FILE-26)', () => {
  it('writes the PENDING row BEFORE signing the permission', async () => {
    const order: string[] = [];
    const provider = new MockStorageProvider();
    const originalSign = provider.signUpload.bind(provider);
    provider.signUpload = async (input) => {
      order.push('sign');
      return originalSign(input);
    };

    const { service } = makeService({
      provider,
      create: async (input) => {
        order.push('row');
        return { ...(input as object), id: FILE_ID };
      },
    });

    await service.createUpload({
      ownerUserId: OWNER,
      purpose: 'PROFILE_IMAGE',
      fileName: 'me.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1024,
    });

    assert.deepEqual(order, ['row', 'sign']);
  });

  it('stores a server-generated key the client never influenced', async () => {
    const { service, created } = makeService({});

    await service.createUpload({
      ownerUserId: OWNER,
      purpose: 'DRIVER_DOCUMENT',
      fileName: '../../etc/passwd',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    });

    const row = created[0] as { storageKey: string; fileName: string };
    assert.match(row.storageKey, STORAGE_KEY_PATTERN);
    assert.equal(row.storageKey.includes('passwd'), false, 'the filename never reaches the key');
    assert.equal(row.fileName, 'passwd.pdf', 'but it is kept, sanitized, for display');
  });

  // The grant binds the DECLARED size, because S3's signed Content-Length is an
  // exact match rather than a ceiling — binding 5 MB would make every avatar
  // under 5 MB fail. "At most the ceiling" is still guaranteed, one step
  // earlier: a declaration above it never reaches signUpload at all.
  it('binds the declared size into the signature, so the object must be exactly that long', async () => {
    const provider = new MockStorageProvider();
    let boundLength = 0;
    const originalSign = provider.signUpload.bind(provider);
    provider.signUpload = async (input) => {
      boundLength = input.contentLength;
      return originalSign(input);
    };

    const { service } = makeService({ provider });
    await service.createUpload({
      ownerUserId: OWNER,
      purpose: 'PROFILE_IMAGE',
      fileName: 'me.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
    });

    assert.equal(boundLength, 10);
  });

  it('never signs a grant for a declaration above the purpose ceiling', async () => {
    const provider = new MockStorageProvider();
    let signed = false;
    provider.signUpload = async () => {
      signed = true;
      throw new Error('should never be reached');
    };

    const { service } = makeService({ provider });
    await assert.rejects(
      service.createUpload({
        ownerUserId: OWNER,
        purpose: 'PROFILE_IMAGE',
        fileName: 'huge.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 5 * 1024 * 1024 + 1,
      }),
      /larger than this upload allows/,
    );
    assert.equal(signed, false, 'an oversized declaration reached the signer');
  });
});

describe('FileService.completeUpload — unit of work (R-FILE-24)', () => {
  const pendingRow = {
    id: FILE_ID,
    ownerUserId: OWNER,
    purpose: 'PROFILE_IMAGE',
    status: 'PENDING',
    storageKey: 'pi/2026/08/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    contentType: 'image/png',
    sizeBytes: 100,
    checksumSha256: null,
    uploadExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 5_000),
  };

  function pngHeader(): Buffer {
    return png({ width: 1, height: 1 });
  }

  it('writes the row change and the event in the SAME transaction', async () => {
    const provider = new MockStorageProvider();
    provider.putObject(pendingRow.storageKey, pngHeader(), 'image/png');

    let seenTx: unknown = null;
    const { service, published } = makeService({
      provider,
      findOwned: async () => pendingRow,
      markReady: async () => true,
      publish: async (_event, tx) => {
        seenTx = tx;
      },
    });

    await service.completeUpload(FILE_ID, OWNER, 'req-1');

    assert.equal(published.length, 1);
    assert.deepEqual(seenTx, { marker: 'the-tx' }, 'the event carries the same tx as the write');
  });

  it('emits nothing when the conditional transition loses (FILE-INV-6)', async () => {
    const provider = new MockStorageProvider();
    provider.putObject(pendingRow.storageKey, pngHeader(), 'image/png');

    let settled = false;
    const { service, published } = makeService({
      provider,
      findOwned: async () => (settled ? { ...pendingRow, status: 'READY' } : pendingRow),
      markReady: async () => {
        settled = true;
        return false;
      },
    });

    const result = await service.completeUpload(FILE_ID, OWNER);

    assert.equal(published.length, 0);
    assert.equal(result.status, 'READY', 'the loser still observes success');
  });

  it('emits an event payload carrying no key, no URL, and no filename (doc 05 §4)', async () => {
    const provider = new MockStorageProvider();
    provider.putObject(pendingRow.storageKey, pngHeader(), 'image/png');

    const { service, published } = makeService({
      provider,
      findOwned: async () => pendingRow,
    });

    await service.completeUpload(FILE_ID, OWNER);

    const payload = JSON.stringify((published[0]?.event as { data: unknown }).data);
    assert.equal(payload.includes(pendingRow.storageKey), false, 'no storage key');
    assert.equal(payload.includes('mock-storage.local'), false, 'no URL');
    assert.equal(payload.includes('fileName'), false, 'no filename');
    assert.match(payload, /"purpose":"PROFILE_IMAGE"/);
  });

  it('returns the stored result for an already-READY file without re-emitting', async () => {
    const { service, published } = makeService({
      findOwned: async () => ({ ...pendingRow, status: 'READY', completedAt: new Date() }),
    });

    const result = await service.completeUpload(FILE_ID, OWNER);

    assert.equal(result.status, 'READY');
    assert.equal(published.length, 0, 'a retried completion announces nothing further');
  });
});
