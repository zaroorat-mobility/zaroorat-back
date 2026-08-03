import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearFileReferences,
  findLiveReference,
  registerFileReference,
} from '../../../src/modules/files/file-references.js';

/**
 * The reference guard (files doc 01 R-FILE-19/33, FILE-INV-5).
 *
 * `files` cannot read another module's tables, so "is anyone still using this?"
 * is answered by asking the module that would know. These tests pin the two
 * properties that make that safe: an unregistered purpose is **not** an implicit
 * yes, and the answer is a module name rather than a count (FILES-OD-13).
 */
describe('file reference guard', () => {
  afterEach(() => {
    clearFileReferences();
  });

  it('reports nothing held when no module has registered', async () => {
    // The v1 state: no domain table has a file-id column yet (doc 01 §13.1), so
    // nothing can hold a reference and every delete is free to proceed.
    assert.equal(await findLiveReference('PROFILE_IMAGE', 'f1'), null);
  });

  it('names the holding module when a live row references the file', async () => {
    registerFileReference('PROFILE_IMAGE', {
      module: 'users',
      isReferenced: async () => true,
    });

    assert.equal(await findLiveReference('PROFILE_IMAGE', 'f1'), 'users');
  });

  it('reports nothing held when the module says it released the file', async () => {
    registerFileReference('PROFILE_IMAGE', {
      module: 'users',
      isReferenced: async () => false,
    });

    assert.equal(await findLiveReference('PROFILE_IMAGE', 'f1'), null);
  });

  it('asks only the module that owns that purpose', async () => {
    const asked: string[] = [];
    registerFileReference('DRIVER_DOCUMENT', {
      module: 'documents',
      isReferenced: async (fileId) => {
        asked.push(fileId);
        return true;
      },
    });

    // Doc 02 §6A maps each purpose to exactly one owning module, which is what
    // keeps the answer a yes/no instead of a count across modules.
    assert.equal(await findLiveReference('PROFILE_IMAGE', 'f1'), null);
    assert.deepEqual(asked, []);
    assert.equal(await findLiveReference('DRIVER_DOCUMENT', 'f2'), 'documents');
    assert.deepEqual(asked, ['f2']);
  });

  it('passes the caller’s transaction through', async () => {
    let received: unknown = 'never called';
    registerFileReference('DRIVER_DOCUMENT', {
      module: 'documents',
      isReferenced: async (_fileId, tx) => {
        received = tx;
        return false;
      },
    });
    const tx = { marker: true };

    // R-FILE-27: the question and the write that depends on it must commit
    // together, so the checker has to see the caller's transaction.
    await findLiveReference('DRIVER_DOCUMENT', 'f1', tx as never);

    assert.equal(received, tx);
  });

  it('lets a re-registration replace the previous owner', async () => {
    registerFileReference('PROFILE_IMAGE', { module: 'old', isReferenced: async () => true });
    registerFileReference('PROFILE_IMAGE', { module: 'users', isReferenced: async () => true });

    assert.equal(await findLiveReference('PROFILE_IMAGE', 'f1'), 'users');
  });

  it('propagates a checker failure rather than reading it as “not referenced”', async () => {
    registerFileReference('PROFILE_IMAGE', {
      module: 'users',
      isReferenced: async () => {
        throw new Error('database unavailable');
      },
    });

    // Fail-closed: a module that cannot answer must never be read as consent to
    // delete. Swallowing this would erase a file somebody still references.
    await assert.rejects(() => findLiveReference('PROFILE_IMAGE', 'f1'), /database unavailable/);
  });
});
