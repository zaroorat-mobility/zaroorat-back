import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
import { fileConfig } from '../../src/config/file/file.config.js';
import type { MockStorageProvider } from '../../src/modules/files/providers/mock.provider.js';

/** A valid 800x600 PNG header. */
function png(): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(800, 16);
  header.writeUInt32BE(600, 20);
  return header;
}

/**
 * Fail-closed behaviour, rate limits, and the properties the read path claims
 * about credential lifetime (files doc 06 §5).
 *
 * These exist because the module's failure modes are where it is most dangerous:
 * a dependency that cannot answer must never be read as permission, and must
 * never surface as a `200` carrying a null URL (doc 04 §6).
 */
describe('file resilience (integration)', () => {
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

  const BODY = {
    purpose: 'PROFILE_IMAGE',
    fileName: 'me.png',
    contentType: 'image/png',
    sizeBytes: 2048,
  };

  function createUpload(auth: { authorization: string }) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: BODY,
    });
  }

  /** Upload and complete, returning the file id. */
  async function publish(auth: { authorization: string }): Promise<string> {
    const created = await createUpload(auth);
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, png(), 'image/png');
    await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    return fileId;
  }

  function readUrl(auth: { authorization: string }, fileId: string) {
    return app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/url`, headers: auth });
  }

  // ── Fail-closed (doc 04 §6, doc 06 §5) ────────────────────────────────────

  describe('when the storage backend is unreachable', () => {
    it('answers 503 on sign, never a 500 and never a 200', async () => {
      const user = await loginAs(app, '+919876560001');
      provider.failNext('signUpload', true);

      const response = await createUpload(user.authHeader);

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(response.headers['retry-after'], '5');
    });

    it('answers 503 on complete', async () => {
      const user = await loginAs(app, '+919876560002');
      const created = await createUpload(user.authHeader);
      const fileId = created.json().fileId as string;
      provider.failNext('head', true);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/files/${fileId}/complete`,
        headers: user.authHeader,
      });

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'SERVICE_UNAVAILABLE');
    });

    it('answers 503 on read, never a 200 with a null url', async () => {
      const user = await loginAs(app, '+919876560003');
      const fileId = await publish(user.authHeader);
      provider.failNext('signDownload', true);

      const response = await readUrl(user.authHeader, fileId);

      assert.equal(response.statusCode, 503);
      assert.equal(response.json().url, undefined, 'no half-built success body');
    });

    it('uses the platform error envelope, not Fastify’s default shape', async () => {
      const user = await loginAs(app, '+919876560004');
      provider.failNext('signUpload', true);

      const body = (await createUpload(user.authHeader)).json();

      // The bug this test was written for: an unmapped StorageError reached
      // Fastify's generic handler and produced {statusCode, error, message} —
      // a shape no client of this API knows how to read.
      assert.deepEqual(Object.keys(body), ['error']);
      assert.ok(body.error.messageKey, 'carries an i18n key');
      assert.ok(body.error.requestId, 'carries a correlation id');
    });

    it('never leaks the internal operation name or the provider error', async () => {
      const user = await loginAs(app, '+919876560005');
      provider.failNext('signUpload', true);

      const payload = (await createUpload(user.authHeader)).payload;

      // The same bug leaked `Storage operation "signUpload" failed` to the
      // client, which doc 04 §5 forbids.
      assert.equal(payload.includes('signUpload'), false);
      assert.equal(payload.includes('injected mock failure'), false);
      assert.equal(payload.includes('mock-storage'), false);
    });

    it('recovers as soon as the backend does', async () => {
      const user = await loginAs(app, '+919876560006');
      provider.failNext('signUpload', true);

      assert.equal((await createUpload(user.authHeader)).statusCode, 503);
      assert.equal((await createUpload(user.authHeader)).statusCode, 201, 'not latched');
    });

    it('leaves a reclaimable reservation rather than an untracked object', async () => {
      const user = await loginAs(app, '+919876560007');
      provider.failNext('signUpload', true);

      await createUpload(user.authHeader);

      // R-FILE-26's payoff: the row exists and the sweeper will collect it. The
      // reverse ordering would have left a signed permission for a key nothing
      // knows about.
      const pending = await db().client.file.count({ where: { status: 'PENDING' } });
      assert.equal(pending, 1);
    });
  });

  // ── Rate limits (02 §6, R-FILE-9) ─────────────────────────────────────────

  describe('rate limits', () => {
    it('trips the per-purpose upload axis and reports Retry-After', async () => {
      const user = await loginAs(app, '+919876560010');
      const limit = fileConfig.uploadsPerPurposePerHour;

      const responses = [];
      for (let attempt = 0; attempt < limit + 1; attempt += 1) {
        responses.push(await createUpload(user.authHeader));
      }

      const last = responses[responses.length - 1];
      assert.equal(last?.statusCode, 429);
      assert.equal(last?.json().error.code, 'RATE_LIMITED');
      assert.ok(last?.headers['retry-after'], 'mirrors the header');
      assert.equal(
        responses.filter((r) => r.statusCode === 201).length,
        limit,
        'exactly the limit got through',
      );
    });

    it('trips the read axis independently of the upload axis', async () => {
      const user = await loginAs(app, '+919876560011');
      const fileId = await publish(user.authHeader);

      let throttled = 0;
      for (let attempt = 0; attempt < fileConfig.readUrlsPerUserPerMinute + 2; attempt += 1) {
        const response = await readUrl(user.authHeader, fileId);
        if (response.statusCode === 429) throttled += 1;
      }

      assert.ok(throttled > 0, 'the read axis has its own budget and it trips');
    });
  });

  // ── Credential lifetime (R-FILE-34, FILES-OD-14) ──────────────────────────

  describe('a minted read URL', () => {
    it('stays valid after the account is suspended — the TTL is the bound', async () => {
      const user = await loginAs(app, '+919876560020');
      const fileId = await publish(user.authHeader);
      const url = (await readUrl(user.authHeader, fileId)).json().url as string;

      await db().client.user.update({
        where: { id: user.userId },
        data: { status: 'SUSPENDED' },
      });

      // FILES-OD-14, stated rather than left to look like an oversight: a signed
      // URL is a bearer credential held by the client, and the only ways to
      // revoke one are rotating the signing key (which invalidates everyone's)
      // or proxying every read through the API (which is what R-FILE-1 exists to
      // avoid). The exposure is bounded by a TTL measured in minutes.
      assert.equal(provider.verifyUrl(url, { method: 'GET' }).ok, true);
    });

    it('cannot be minted again once the session is revoked', async () => {
      const user = await loginAs(app, '+919876560021');
      const fileId = await publish(user.authHeader);

      // Revocation is the **epoch bump**, not a status column: the gate checks
      // the token's `epoch` claim against Redis, which is what makes revocation
      // take effect within one request cycle (NFR-5). Writing
      // `users.status = SUSPENDED` directly would change nothing the gate reads
      // — a mistake this test originally made, and the reason it is spelled out.
      const epochService = container.resolve<{ bump: (id: string) => Promise<number> }>(
        'epochService',
      );
      await epochService.bump(user.userId);

      const response = await readUrl(user.authHeader, fileId);

      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'TOKEN_STALE');
    });
  });

  // ── Authorization precedes minting (R-FILE-13) ────────────────────────────

  describe('a denied read', () => {
    it('signs nothing at all', async () => {
      const owner = await loginAs(app, '+919876560030');
      const stranger = await loginAs(app, '+919876560031');
      const fileId = await publish(owner.authHeader);
      const before = provider.calls.signDownload;

      const response = await readUrl(stranger.authHeader, fileId);

      assert.equal(response.statusCode, 404);
      // R-FILE-13: authorization is decided *before* minting, never from
      // possession of an id. A signature minted and then discarded would still
      // have existed, and a bug could return it.
      assert.equal(provider.calls.signDownload, before);
    });
  });
});
