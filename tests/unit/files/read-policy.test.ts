import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideRead } from '../../../src/modules/files/services/file-access.service.js';
import type { FilePurposeName } from '../../../src/config/file/file.config.js';

const OWNER = 'user-owner';
const OTHER = 'user-other';

const PURPOSES: FilePurposeName[] = [
  'PROFILE_IMAGE',
  'DRIVER_DOCUMENT',
  'VEHICLE_DOCUMENT',
  'VEHICLE_IMAGE',
  'SOS_EVIDENCE',
  'DISPUTE_EVIDENCE',
];

describe('read policy', () => {
  it('always grants the owner, for every purpose', () => {
    for (const purpose of PURPOSES) {
      assert.deepEqual(
        decideRead({ ownerUserId: OWNER, purpose }, { userId: OWNER, roles: ['customer'] }),
        { granted: true, actor: 'owner' },
        purpose,
      );
    }
  });

  it('denies an unrelated user every purpose, whatever ordinary roles they hold', () => {
    for (const purpose of PURPOSES) {
      assert.deepEqual(
        decideRead(
          { ownerUserId: OWNER, purpose },
          { userId: OTHER, roles: ['customer', 'driver'] },
        ),
        { granted: false },
        purpose,
      );
    }
  });

  it('grants an admin every purpose, naming the scope that authorized it', () => {
    assert.deepEqual(
      decideRead(
        { ownerUserId: OWNER, purpose: 'DRIVER_DOCUMENT' },
        { userId: OTHER, roles: ['admin'] },
      ),
      { granted: true, actor: 'ops', scope: 'drivers:verify' },
    );
    assert.deepEqual(
      decideRead(
        { ownerUserId: OWNER, purpose: 'PROFILE_IMAGE' },
        { userId: OTHER, roles: ['admin'] },
      ),
      { granted: true, actor: 'ops', scope: 'users:read' },
    );
  });

  it('scopes support to disputes and safety, and no further', () => {
    const support = { userId: OTHER, roles: ['support'] };

    assert.equal(
      decideRead({ ownerUserId: OWNER, purpose: 'DISPUTE_EVIDENCE' }, support).granted,
      true,
    );
    assert.equal(
      decideRead({ ownerUserId: OWNER, purpose: 'SOS_EVIDENCE' }, support).granted,
      true,
    );

    assert.equal(
      decideRead({ ownerUserId: OWNER, purpose: 'DRIVER_DOCUMENT' }, support).granted,
      false,
    );
    assert.equal(
      decideRead({ ownerUserId: OWNER, purpose: 'PROFILE_IMAGE' }, support).granted,
      false,
    );
  });

  it('gives an ops actor reading their OWN file the owner grant, not an audited one', () => {
    assert.deepEqual(
      decideRead(
        { ownerUserId: OWNER, purpose: 'PROFILE_IMAGE' },
        { userId: OWNER, roles: ['admin'] },
      ),
      { granted: true, actor: 'owner' },
    );
  });

  it('denies a caller with no roles at all', () => {
    assert.deepEqual(
      decideRead({ ownerUserId: OWNER, purpose: 'PROFILE_IMAGE' }, { userId: OTHER, roles: [] }),
      { granted: false },
    );
  });

  it('ignores a role that carries no file scopes', () => {
    assert.deepEqual(
      decideRead(
        { ownerUserId: OWNER, purpose: 'SOS_EVIDENCE' },
        { userId: OTHER, roles: ['driver'] },
      ),
      { granted: false },
    );
  });
});
