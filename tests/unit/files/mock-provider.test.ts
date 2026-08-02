import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { MockStorageProvider } from '../../../src/modules/files/providers/mock.provider.js';
import { StorageError } from '../../../src/modules/files/providers/storage.provider.js';

/**
 * The mock provider is a deliverable, not a fixture (files doc 07 §7): every
 * other FILES test trusts it, so the properties it claims are asserted here
 * first. If the mock does not model versioning, the erase test in phase 6 would
 * pass against a provider that never reproduced the bug it guards (doc 08 §2.2).
 */
describe('MockStorageProvider', () => {
  const KEY = 'dd/2026/08/c9f0f895fb98ab9159f51fd0297e236d.pdf';
  let provider: MockStorageProvider;

  beforeEach(() => {
    provider = new MockStorageProvider();
  });

  // ── Versioning: the property the real bucket has and a Map does not ────────

  describe('versioning', () => {
    it('keeps every write as a distinct version', () => {
      provider.putObject(KEY, Buffer.from('v1'), 'application/pdf');
      provider.putObject(KEY, Buffer.from('v2'), 'application/pdf');
      provider.putObject(KEY, Buffer.from('v3'), 'application/pdf');

      assert.equal(provider.versionIds(KEY).length, 3);
    });

    it('serves the newest version from head', async () => {
      provider.putObject(KEY, Buffer.from('old'), 'application/pdf');
      provider.putObject(KEY, Buffer.from('newest'), 'application/pdf');

      const head = await provider.head(KEY, 512);
      assert.equal(head?.peek.toString(), 'newest');
    });

    it('delete() hides the object but LEAVES the earlier versions', async () => {
      provider.putObject(KEY, Buffer.from('v1'), 'application/pdf');
      provider.putObject(KEY, Buffer.from('v2'), 'application/pdf');

      await provider.delete(KEY);

      assert.equal(await provider.head(KEY, 512), null, 'hidden by the delete marker');
      // Two versions plus the marker. This is the trap doc 08 §2.2 describes:
      // on a versioned bucket a delete destroys nothing.
      assert.equal(provider.versionIds(KEY).length, 3);
    });

    it('erase() removes every version and the delete marker', async () => {
      provider.putObject(KEY, Buffer.from('v1'), 'application/pdf');
      provider.putObject(KEY, Buffer.from('v2'), 'application/pdf');
      await provider.delete(KEY);

      await provider.erase(KEY);

      // The contrast with the previous test is the whole point: "gone" has to
      // mean gone exactly once, on the retention path (R-FILE-23).
      assert.deepEqual(provider.versionIds(KEY), []);
      assert.equal(await provider.head(KEY, 512), null);
    });

    it('is idempotent for delete and erase on an absent key', async () => {
      await provider.delete(KEY);
      await provider.erase(KEY);
      await provider.delete(KEY);
      assert.deepEqual(provider.versionIds(KEY), []);
    });

    it('does not stack delete markers on an already-hidden object', async () => {
      provider.putObject(KEY, Buffer.from('v1'), 'application/pdf');
      await provider.delete(KEY);
      await provider.delete(KEY);

      assert.equal(provider.versionIds(KEY).length, 2, 'one version, one marker');
    });
  });

  // ── Archive is the opposite of erase ──────────────────────────────────────

  describe('archive', () => {
    it('preserves the bytes and marks the storage class', async () => {
      provider.putObject(KEY, Buffer.from('evidence'), 'application/pdf');

      await provider.archive(KEY);

      assert.equal(provider.isArchived(KEY), true);
      const head = await provider.head(KEY, 512);
      assert.equal(head?.peek.toString(), 'evidence', 'archive never removes bytes (R-FILE-21)');
    });

    it('refuses to archive an object that is not there', async () => {
      // Unlike delete, this is a real fault: retention asked to preserve
      // something that does not exist, which means its bookkeeping is wrong.
      await assert.rejects(() => provider.archive(KEY), StorageError);
    });
  });

  // ── Signatures actually bind something ────────────────────────────────────

  describe('signed upload URLs', () => {
    it('accepts the exact request it was signed for', async () => {
      const signed = await provider.signUpload({
        key: KEY,
        contentType: 'application/pdf',
        maxBytes: 1000,
        ttlSeconds: 900,
      });

      const verdict = provider.verifyUrl(signed.url, {
        method: 'PUT',
        contentType: 'application/pdf',
        sizeBytes: 999,
      });
      assert.deepEqual(verdict, { ok: true, key: KEY });
    });

    it('binds the method — a read cannot be attempted with a write permission', async () => {
      const signed = await provider.signUpload({
        key: KEY,
        contentType: 'application/pdf',
        maxBytes: 1000,
        ttlSeconds: 900,
      });

      const verdict = provider.verifyUrl(signed.url, { method: 'GET' });
      assert.deepEqual(verdict, { ok: false, reason: 'wrong-method' });
    });

    it('binds the content-type', async () => {
      const signed = await provider.signUpload({
        key: KEY,
        contentType: 'application/pdf',
        maxBytes: 1000,
        ttlSeconds: 900,
      });

      const verdict = provider.verifyUrl(signed.url, {
        method: 'PUT',
        contentType: 'image/jpeg',
      });
      assert.deepEqual(verdict, { ok: false, reason: 'wrong-content-type' });
    });

    it('binds the size ceiling, rather than merely checking it afterwards (R-FILE-2)', async () => {
      const signed = await provider.signUpload({
        key: KEY,
        contentType: 'application/pdf',
        maxBytes: 1000,
        ttlSeconds: 900,
      });

      const verdict = provider.verifyUrl(signed.url, {
        method: 'PUT',
        contentType: 'application/pdf',
        sizeBytes: 1001,
      });
      assert.deepEqual(verdict, { ok: false, reason: 'too-large' });
    });

    it('cannot be edited to point at another key', async () => {
      const signed = await provider.signUpload({
        key: KEY,
        contentType: 'application/pdf',
        maxBytes: 1000,
        ttlSeconds: 900,
      });

      const tampered = signed.url.replace(encodeURIComponent(KEY), encodeURIComponent('pi/x.jpg'));
      const verdict = provider.verifyUrl(tampered, { method: 'PUT' });
      assert.deepEqual(verdict, { ok: false, reason: 'bad-signature' });
    });
  });

  // ── TTL, through the clock seam rather than a timer ───────────────────────

  describe('expiry', () => {
    it('accepts a URL a second before it expires and refuses it a second after', async () => {
      const start = new Date('2026-08-02T10:00:00Z');
      provider.setClock(() => start);

      const signed = await provider.signDownload({
        key: KEY,
        ttlSeconds: 300,
        contentType: 'application/pdf',
        disposition: 'inline',
        fileName: 'licence.pdf',
      });
      assert.equal(signed.expiresAt.toISOString(), '2026-08-02T10:05:00.000Z');

      provider.setClock(() => new Date('2026-08-02T10:04:59Z'));
      assert.equal(provider.verifyUrl(signed.url, { method: 'GET' }).ok, true);

      provider.setClock(() => new Date('2026-08-02T10:05:01Z'));
      assert.deepEqual(provider.verifyUrl(signed.url, { method: 'GET' }), {
        ok: false,
        reason: 'expired',
      });
    });
  });

  // ── Fail-closed support ───────────────────────────────────────────────────

  describe('injected failures', () => {
    it('throws a StorageError carrying the operation and the retryable flag', async () => {
      provider.failNext('signUpload', true);

      await assert.rejects(
        () =>
          provider.signUpload({
            key: KEY,
            contentType: 'application/pdf',
            maxBytes: 1000,
            ttlSeconds: 900,
          }),
        (error: unknown) => {
          assert.ok(error instanceof StorageError);
          assert.equal(error.operation, 'signUpload');
          assert.equal(error.retryable, true);
          return true;
        },
      );
    });

    it('fails only the requested number of calls', async () => {
      provider.failNext('head', true, 2);

      await assert.rejects(() => provider.head(KEY, 512));
      await assert.rejects(() => provider.head(KEY, 512));
      assert.equal(await provider.head(KEY, 512), null, 'third call runs normally');
    });

    it('carries retryable: false for a configuration fault', async () => {
      provider.failNext('health', false);
      await assert.rejects(
        () => provider.health(),
        (error: unknown) => error instanceof StorageError && error.retryable === false,
      );
    });
  });

  // ── Call recording, for "no byte transits the API" ────────────────────────

  describe('call recording', () => {
    it('counts every contract call', async () => {
      await provider.signUpload({
        key: KEY,
        contentType: 'application/pdf',
        maxBytes: 10,
        ttlSeconds: 60,
      });
      await provider.head(KEY, 512);
      await provider.head(KEY, 512);

      assert.equal(provider.calls.signUpload, 1);
      assert.equal(provider.calls.head, 2);
      assert.equal(provider.calls.delete, 0);
    });

    it('reset() clears objects, failures, and counts', async () => {
      provider.putObject(KEY, Buffer.from('x'), 'application/pdf');
      provider.failNext('head');

      provider.reset();

      assert.deepEqual(provider.versionIds(KEY), []);
      assert.equal(provider.calls.head, 0);
      assert.equal(await provider.head(KEY, 512), null, 'no failure remained queued');
    });
  });

  describe('health', () => {
    it('always reports healthy — CI must not need a bucket', async () => {
      assert.deepEqual(await provider.health(), {
        reachable: true,
        bucketExists: true,
        credentialsValid: true,
        latencyMs: 0,
      });
    });
  });
});
