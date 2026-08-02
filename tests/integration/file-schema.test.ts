import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState } from './helpers/harness.js';

/**
 * The guarantees the migration makes (files doc 06 §7, doc 03 §4).
 *
 * These exist because **application checks are a courtesy and constraints are
 * the guarantee** — and because a constraint nothing exercises is a constraint a
 * future migration can drop in silence. Every object below was verified by hand
 * once; this file is what keeps it verified.
 */
describe('files schema (integration)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = await bootApp();
  });
  after(async () => {
    await app.close();
  });
  afterEach(async () => {
    await resetState();
  });

  /** Insert a user to own the rows under test. */
  async function makeUser(): Promise<string> {
    const user = await db().client.user.create({
      data: { phoneNumber: `+9199${Math.floor(Math.random() * 100000000)}`, status: 'ACTIVE' },
    });
    return user.id;
  }

  /** Raw insert, bypassing every application check, so the database answers alone. */
  async function rawInsert(columns: Record<string, unknown>): Promise<void> {
    const names = Object.keys(columns);
    const values = Object.values(columns);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    await db().client.$executeRawUnsafe(
      `INSERT INTO files (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${placeholders})`,
      ...values,
    );
  }

  /** The columns a minimally valid PENDING row needs. */
  function pendingRow(ownerUserId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: randomUUID(),
      owner_user_id: ownerUserId,
      purpose: 'PROFILE_IMAGE',
      status: 'PENDING',
      storage_key: `pi/2026/08/${randomUUID().replaceAll('-', '')}.jpg`,
      storage_provider: 'mock',
      file_name: 'a.jpg',
      content_type: 'image/jpeg',
      size_bytes: 10,
      upload_expires_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
  }

  // ── The objects exist, by the names the docs publish ──────────────────────

  describe('the documented objects', () => {
    it('ships every index doc 03 §4 names', async () => {
      const rows = await db().client.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'files'`;
      const names = rows.map((row) => row.indexname).sort();

      for (const expected of [
        'files_pkey',
        'files_superseded_by_id_key',
        'ix_files_owner',
        'ix_files_retention',
        'ix_files_retention_pending',
        'ix_files_sweep',
        'ix_files_sweep_pending',
        'uq_files_one_live_profile_image',
        'uq_files_storage_key',
      ]) {
        assert.ok(names.includes(expected), `missing index ${expected}`);
      }
    });

    it('ships every CHECK constraint doc 03 §4.3 names', async () => {
      const rows = await db().client.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'files'::regclass AND contype = 'c'`;
      const names = rows.map((row) => row.conname);

      for (const expected of [
        'ck_files_ready_is_complete',
        'ck_files_terminal_implies_closed',
        'ck_files_archive_xor_erase',
        'ck_files_superseded_has_successor',
      ]) {
        assert.ok(names.includes(expected), `missing constraint ${expected}`);
      }
    });

    it('references users, and refuses to orphan a file', async () => {
      const rows = await db().client.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'files'::regclass AND contype = 'f'`;
      const names = rows.map((row) => row.conname);
      assert.ok(names.includes('files_owner_user_id_fkey'));
      assert.ok(names.includes('files_superseded_by_id_fkey'));
    });

    it('keeps uq_files_storage_key TOTAL, not partial', async () => {
      // Partial would let a key be reused once its row was erased, and a stale
      // signed URL would then resolve to somebody else's object (doc 03 §4.1).
      const [row] = await db().client.$queryRaw<{ pred: string | null }[]>`
        SELECT pg_get_expr(i.indpred, i.indrelid) AS pred
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'uq_files_storage_key'`;
      assert.equal(row?.pred, null, 'it must have no WHERE clause');
    });

    it('keeps the two job indexes partial, so they scan the backlog not the table', async () => {
      const rows = await db().client.$queryRaw<{ relname: string; pred: string | null }[]>`
        SELECT c.relname, pg_get_expr(i.indpred, i.indrelid) AS pred
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN ('ix_files_sweep_pending', 'ix_files_retention_pending')`;

      const sweep = rows.find((row) => row.relname === 'ix_files_sweep_pending');
      const retention = rows.find((row) => row.relname === 'ix_files_retention_pending');
      assert.match(String(sweep?.pred), /PENDING/);
      assert.match(String(retention?.pred), /SUPERSEDED/);
      assert.match(String(retention?.pred), /erased_at IS NULL/);
    });
  });

  // ── The constraints actually reject ───────────────────────────────────────

  describe('the constraints refuse illegal rows', () => {
    it('refuses a READY row with no completion evidence (FILE-INV-3)', async () => {
      const owner = await makeUser();
      // This is what makes "attach only READY files" structural rather than
      // application-enforced: a forged state cannot satisfy it.
      await assert.rejects(
        () => rawInsert(pendingRow(owner, { status: 'READY', completed_at: null })),
        /ck_files_ready_is_complete/,
      );
    });

    it('refuses a file both archived and erased (FILE-INV-9)', async () => {
      const owner = await makeUser();
      // Archive and erase are opposite outcomes. This constraint is what makes
      // the `action` field in `file.erased` trustworthy (doc 05 §3.5).
      await assert.rejects(
        () =>
          rawInsert(
            pendingRow(owner, {
              status: 'DELETED',
              deleted_at: new Date(),
              archived_at: new Date(),
              erased_at: new Date(),
            }),
          ),
        /ck_files_archive_xor_erase/,
      );
    });

    it('refuses a SUPERSEDED row that names no successor (FILE-INV-8)', async () => {
      const owner = await makeUser();
      await assert.rejects(
        () => rawInsert(pendingRow(owner, { status: 'SUPERSEDED', superseded_by_id: null })),
        /ck_files_superseded_has_successor/,
      );
    });

    it('refuses a terminal outcome on a row still in the read path', async () => {
      const owner = await makeUser();
      await assert.rejects(
        () => rawInsert(pendingRow(owner, { status: 'PENDING', erased_at: new Date() })),
        /ck_files_terminal_implies_closed/,
      );
    });
  });

  // ── FILE-INV-1: keys are never reused ─────────────────────────────────────

  describe('storage keys (FILE-INV-1)', () => {
    it('refuses a duplicate key', async () => {
      const owner = await makeUser();
      const key = `pi/2026/08/${randomUUID().replaceAll('-', '')}.jpg`;

      await rawInsert(pendingRow(owner, { storage_key: key }));
      await assert.rejects(
        () => rawInsert(pendingRow(owner, { storage_key: key })),
        /uq_files_storage_key/,
      );
    });

    it('refuses a key reused after the original was erased', async () => {
      const owner = await makeUser();
      const key = `pi/2026/08/${randomUUID().replaceAll('-', '')}.jpg`;
      const first = randomUUID();

      await rawInsert(pendingRow(owner, { id: first, storage_key: key }));
      await db().client.$executeRawUnsafe(
        `UPDATE files SET status = 'DELETED', deleted_at = now(), erased_at = now() WHERE id = $1::uuid`,
        first,
      );

      // The whole point of the index being total: an erased row still holds its
      // key, so a stale signed URL can never resolve to a different object.
      await assert.rejects(
        () => rawInsert(pendingRow(owner, { storage_key: key })),
        /uq_files_storage_key/,
      );
    });
  });

  // ── The profile-image partial unique, in both directions ──────────────────

  describe('uq_files_one_live_profile_image (doc 03 §4.4)', () => {
    it('refuses a second live profile image for one user', async () => {
      const owner = await makeUser();
      await rawInsert(
        pendingRow(owner, { status: 'READY', completed_at: new Date(), size_bytes: 10 }),
      );

      await assert.rejects(
        () => rawInsert(pendingRow(owner, { status: 'READY', completed_at: new Date() })),
        /uq_files_one_live_profile_image/,
      );
    });

    it('ACCEPTS a replacement once the first is soft-deleted', async () => {
      const owner = await makeUser();
      const first = randomUUID();
      await rawInsert(pendingRow(owner, { id: first, status: 'READY', completed_at: new Date() }));
      await db().client.$executeRawUnsafe(
        `UPDATE files SET status = 'DELETED', deleted_at = now() WHERE id = $1::uuid`,
        first,
      );

      // Without this direction the index would look identical in every negative
      // test above and would have made avatar replacement impossible.
      await assert.doesNotReject(() =>
        rawInsert(pendingRow(owner, { status: 'READY', completed_at: new Date() })),
      );
    });

    it('lets two different users each hold a live profile image', async () => {
      const first = await makeUser();
      const second = await makeUser();
      await rawInsert(pendingRow(first, { status: 'READY', completed_at: new Date() }));
      await assert.doesNotReject(() =>
        rawInsert(pendingRow(second, { status: 'READY', completed_at: new Date() })),
      );
    });
  });

  // ── FILE-INV-7: purpose is immutable ──────────────────────────────────────

  describe('purpose immutability (FILE-INV-7)', () => {
    it('is never written by any repository update path', async () => {
      // Enforced by construction rather than by the database: Postgres cannot
      // express column immutability without a trigger, and a trigger for a value
      // no code path touches is machinery guarding nothing. Doc 03 §3.1
      // previously claimed §4.3 enforced this — corrected, since it did not.
      const { readFileSync } = await import('node:fs');
      const repository = readFileSync('src/modules/files/repositories/file.repository.ts', 'utf8');

      const updateBlocks = repository.split(/\.update(?:Many)?\(/).slice(1);
      assert.ok(updateBlocks.length > 0, 'there are update calls to check');
      for (const block of updateBlocks) {
        const body = block.slice(0, block.indexOf('});'));
        assert.equal(body.includes('purpose'), false, 'an update path writes purpose');
      }
    });
  });
});
