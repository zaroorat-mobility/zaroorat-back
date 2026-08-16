import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearFileReferences,
  findLiveReference,
  registerFileReference,
} from '../../../src/modules/files/services/file-reference.service.js';

describe('file reference guard', () => {
  afterEach(() => {
    clearFileReferences();
  });

  it('reports nothing held when no module has registered', async () => {
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

    await assert.rejects(() => findLiveReference('PROFILE_IMAGE', 'f1'), /database unavailable/);
  });
});
