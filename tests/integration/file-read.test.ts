import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, loginAs, resetState } from './helpers/harness.js';
import { container } from '../../src/core/di.js';
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

describe('file read (integration)', () => {
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

  /** Upload and complete a file of the given purpose, returning its id and key. */
  async function publish(
    auth: { authorization: string },
    purpose = 'PROFILE_IMAGE',
  ): Promise<{ fileId: string; key: string }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { purpose, fileName: 'me.png', contentType: 'image/png', sizeBytes: 2048 },
    });
    const fileId = created.json().fileId as string;
    const row = await db().client.file.findUniqueOrThrow({ where: { id: fileId } });
    provider.putObject(row.storageKey, png(), 'image/png');
    await app.inject({
      method: 'POST',
      url: `/api/v1/files/${fileId}/complete`,
      headers: auth,
    });
    return { fileId, key: row.storageKey };
  }

  /** Grant a role to an account, as `admin` will once that module exists. */
  async function grantRole(userId: string, slug: string): Promise<void> {
    const role = await db().client.role.findFirstOrThrow({ where: { slug } });
    await db().client.userRoleAssignment.create({ data: { userId, roleId: role.id } });
  }

  function readUrl(auth: { authorization: string }, fileId: string, query = '') {
    return app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/url${query}`, headers: auth });
  }

  // ── The owner path ────────────────────────────────────────────────────────

  describe('GET /files/:id/url', () => {
    it('mints a URL for the owner, with the purpose TTL', async () => {
      const user = await loginAs(app, '+919876550001');
      const { fileId } = await publish(user.authHeader);

      const response = await readUrl(user.authHeader, fileId);

      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.contentType, 'image/png');
      // PROFILE_IMAGE is 10 minutes (doc 02 §5), and R-FILE-36 keeps every read
      // TTL under the 15-minute access token.
      const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
      assert.ok(ttlMs > 9 * 60_000 && ttlMs <= 10 * 60_000 + 5_000, `ttl was ${ttlMs}ms`);
    });

    it('mints a NEW url every call — nothing is cached (R-FILE-12)', async () => {
      const user = await loginAs(app, '+919876550002');
      const { fileId } = await publish(user.authHeader);

      const first = await readUrl(user.authHeader, fileId);
      const second = await readUrl(user.authHeader, fileId);

      assert.notEqual(first.json().url, second.json().url);
    });

    it('produces a URL the storage backend actually accepts, and only for GET', async () => {
      const user = await loginAs(app, '+919876550003');
      const { fileId, key } = await publish(user.authHeader);

      const url = (await readUrl(user.authHeader, fileId)).json().url as string;

      assert.deepEqual(provider.verifyUrl(url, { method: 'GET' }), { ok: true, key });
      // A read permission cannot be turned into a write one.
      assert.deepEqual(provider.verifyUrl(url, { method: 'PUT' }), {
        ok: false,
        reason: 'wrong-method',
      });
    });

    it('mints a URL that stops working once its TTL passes', async () => {
      const user = await loginAs(app, '+919876550004');
      const { fileId } = await publish(user.authHeader);
      const url = (await readUrl(user.authHeader, fileId)).json().url as string;

      assert.equal(provider.verifyUrl(url, { method: 'GET' }).ok, true);
      // Move the storage clock past the 10-minute window.
      provider.setClock(() => new Date(Date.now() + 11 * 60_000));
      assert.deepEqual(provider.verifyUrl(url, { method: 'GET' }), {
        ok: false,
        reason: 'expired',
      });
    });

    it('honours the disposition and rejects an unknown one', async () => {
      const user = await loginAs(app, '+919876550005');
      const { fileId } = await publish(user.authHeader);

      assert.equal(
        (await readUrl(user.authHeader, fileId, '?disposition=attachment')).statusCode,
        200,
      );
      assert.equal(
        (await readUrl(user.authHeader, fileId, '?disposition=sideways')).statusCode,
        400,
      );
    });

    it('never emits an audit event for an owner reading their own file', async () => {
      const user = await loginAs(app, '+919876550006');
      const { fileId } = await publish(user.authHeader);

      await readUrl(user.authHeader, fileId);

      // Auditing every avatar render would drown the trail in noise; R-FILE-15
      // says *privileged* reads (doc 05 §3).
      const reads = await db().client.outboxEvent.findMany({ where: { eventType: 'file.read' } });
      assert.equal(reads.length, 0);
    });
  });

  // ── Non-disclosure ────────────────────────────────────────────────────────

  describe('a caller who may not read', () => {
    it('cannot tell another user’s file from one that never existed', async () => {
      const owner = await loginAs(app, '+919876550010');
      const stranger = await loginAs(app, '+919876550011');
      const { fileId } = await publish(owner.authHeader);

      const onOthers = await readUrl(stranger.authHeader, fileId);
      const onNothing = await readUrl(stranger.authHeader, randomUUID());

      assert.equal(onOthers.statusCode, 404);
      assert.equal(onNothing.statusCode, 404);
      const strip = (payload: string): unknown => {
        const body = JSON.parse(payload) as { error: Record<string, unknown> };
        delete body.error.requestId;
        return body;
      };
      // Byte-identical, not merely the same code: a shape difference is an
      // oracle too (FILE-INV-4).
      assert.deepEqual(strip(onOthers.payload), strip(onNothing.payload));
    });

    it('is never told a file exists but is forbidden — there is no 403 here', async () => {
      const owner = await loginAs(app, '+919876550012');
      const stranger = await loginAs(app, '+919876550013');
      const { fileId } = await publish(owner.authHeader);

      assert.equal((await readUrl(stranger.authHeader, fileId)).statusCode, 404);
    });

    it('is closed to unauthenticated callers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${randomUUID()}/url`,
      });
      assert.equal(response.statusCode, 401);
    });
  });

  // ── The privileged path, and its audit ────────────────────────────────────

  describe('an ops reader', () => {
    it('may read another user’s file, and the read is audited (R-FILE-15)', async () => {
      const owner = await loginAs(app, '+919876550020');
      const operator = await loginAs(app, '+919876550021');
      await grantRole(operator.userId, 'admin');
      const { fileId } = await publish(owner.authHeader, 'DRIVER_DOCUMENT');

      // Re-login so the token carries the new role claim.
      const opsSession = await loginAs(app, '+919876550021');
      const response = await readUrl(opsSession.authHeader, fileId);

      assert.equal(response.statusCode, 200);

      const [audit] = await db().client.outboxEvent.findMany({
        where: { eventType: 'file.read' },
      });
      assert.ok(audit, 'a privileged read writes an audit record');
      assert.deepEqual((audit.payload as { data: unknown }).data, {
        fileId,
        ownerUserId: owner.userId,
        actorUserId: operator.userId,
        purpose: 'DRIVER_DOCUMENT',
        scope: 'drivers:verify',
      });
    });

    it('writes the audit as durable, not best-effort', async () => {
      const owner = await loginAs(app, '+919876550022');
      await loginAs(app, '+919876550023');
      const operator = await db().client.user.findFirstOrThrow({
        where: { phoneNumber: '+919876550023' },
      });
      await grantRole(operator.id, 'admin');
      const { fileId } = await publish(owner.authHeader, 'SOS_EVIDENCE');

      const opsSession = await loginAs(app, '+919876550023');
      await readUrl(opsSession.authHeader, fileId);

      const [audit] = await db().client.outboxEvent.findMany({
        where: { eventType: 'file.read' },
      });
      // An audit that could be dropped is not an audit: doc 05 §2 puts nothing
      // on the observability tier.
      assert.equal(audit?.status, 'PENDING', 'it is in the durable outbox');
      assert.equal(audit?.aggregateType, 'file');
    });

    it('carries no URL, key, or filename in the audit payload (doc 05 §4)', async () => {
      const owner = await loginAs(app, '+919876550024');
      await loginAs(app, '+919876550025');
      const operator = await db().client.user.findFirstOrThrow({
        where: { phoneNumber: '+919876550025' },
      });
      await grantRole(operator.id, 'admin');
      const { fileId, key } = await publish(owner.authHeader, 'DRIVER_DOCUMENT');

      const opsSession = await loginAs(app, '+919876550025');
      await readUrl(opsSession.authHeader, fileId);

      const events = await db().client.outboxEvent.findMany({ where: { eventType: 'file.read' } });
      const serialized = JSON.stringify(events);
      assert.equal(serialized.includes(key), false, 'no storage key');
      assert.equal(serialized.includes('mock-storage.local'), false, 'no signed URL');
      assert.equal(serialized.includes('me.png'), false, 'no filename');
    });
  });

  // ── Metadata ──────────────────────────────────────────────────────────────

  describe('GET /files/:id', () => {
    it('returns metadata without minting or auditing anything', async () => {
      const user = await loginAs(app, '+919876550030');
      const { fileId } = await publish(user.authHeader);
      const before = provider.calls.signDownload;

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}`,
        headers: user.authHeader,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, 'READY');
      assert.equal(response.json().url, undefined, 'metadata carries no URL');
      assert.equal(provider.calls.signDownload, before, 'nothing was signed');
    });

    it('applies the same visibility rules as the URL route', async () => {
      const owner = await loginAs(app, '+919876550031');
      const stranger = await loginAs(app, '+919876550032');
      const { fileId } = await publish(owner.authHeader);

      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/files/${fileId}`,
        headers: stranger.authHeader,
      });
      assert.equal(response.statusCode, 404);
    });
  });

  // ── Only READY is readable ────────────────────────────────────────────────

  describe('a file that is not READY', () => {
    it('is invisible even to its owner while still PENDING', async () => {
      const user = await loginAs(app, '+919876550040');
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: { ...user.authHeader, 'idempotency-key': randomUUID() },
        payload: {
          purpose: 'PROFILE_IMAGE',
          fileName: 'me.png',
          contentType: 'image/png',
          sizeBytes: 2048,
        },
      });

      const response = await readUrl(user.authHeader, created.json().fileId as string);
      assert.equal(response.statusCode, 404, 'unverified bytes are never served');
    });

    it('is invisible once soft-deleted', async () => {
      const user = await loginAs(app, '+919876550041');
      const { fileId } = await publish(user.authHeader);
      await db().client.file.update({
        where: { id: fileId },
        data: { status: 'DELETED', deletedAt: new Date() },
      });

      assert.equal((await readUrl(user.authHeader, fileId)).statusCode, 404);
    });
  });
});
