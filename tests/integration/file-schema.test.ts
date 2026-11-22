import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { bootApp, db, resetState } from './helpers/harness.js';

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

  async function makeUser(): Promise<string> {
    const user = await db().client.user.create({
      data: { phoneNumber: `+9199${Math.floor(Math.random() * 100000000)}`, status: 'ACTIVE' },
    });
    return user.id;
  }

  async function rawInsert(columns: Record<string, unknown>): Promise<void> {
    const names = Object.keys(columns);
    const values = Object.values(columns);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    await db().client.$executeRawUnsafe(
      `INSERT INTO files (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${placeholders})`,
      ...values,
    );
  }

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

  describe('the constraints refuse illegal rows', () => {
    it('refuses a READY row with no completion evidence (FILE-INV-3)', async () => {
      const owner = await makeUser();

      await assert.rejects(
        () => rawInsert(pendingRow(owner, { status: 'READY', completed_at: null })),
        /ck_files_ready_is_complete/,
      );
    });

    it('refuses a file both archived and erased (FILE-INV-9)', async () => {
      const owner = await makeUser();

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

      await assert.rejects(
        () => rawInsert(pendingRow(owner, { storage_key: key })),
        /uq_files_storage_key/,
      );
    });
  });

  describe('the one-live-avatar rule (doc 03 §4.4 → §7.2)', () => {
    it('is no longer a partial unique on files', async () => {
      const rows = await db().client.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'files'`;

      assert.equal(
        rows.some((row) => row.indexname === 'uq_files_one_live_profile_image'),
        false,
      );
    });

    it('is now the profile’s own column, which is unique', async () => {
      const rows = await db().client.$queryRaw<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'user_profiles'`;
      const unique = rows.find(
        (row) => row.indexname === 'user_profiles_profile_image_file_id_key',
      );

      assert.ok(unique, 'the reference column is unique');
      assert.match(unique.indexdef, /UNIQUE/);
    });

    it('lets one user hold several READY profile images, only one referenced', async () => {
      const owner = await makeUser();
      await rawInsert(pendingRow(owner, { status: 'READY', completed_at: new Date() }));

      await assert.doesNotReject(() =>
        rawInsert(pendingRow(owner, { status: 'READY', completed_at: new Date() })),
      );
    });

    it('refuses two profiles naming the same file (R-FILE-33)', async () => {
      const owner = await makeUser();
      const other = await makeUser();
      const fileId = randomUUID();
      await rawInsert(pendingRow(owner, { id: fileId, status: 'READY', completed_at: new Date() }));
      await db().client.userProfile.create({
        data: { userId: owner, profileImageFileId: fileId },
      });

      await assert.rejects(
        () =>
          db().client.userProfile.create({
            data: { userId: other, profileImageFileId: fileId },
          }),
        /profile_image_file_id/,
      );
    });
  });

  describe('purpose immutability (FILE-INV-7)', () => {
    it('is never written by any repository update path', async () => {
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
