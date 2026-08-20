import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  USER_EVENT_CATALOG,
  USER_PRODUCER,
  userEvent,
  type UserEventType,
} from '../../../src/modules/users/events/catalog.js';

describe('USER event catalog (unit)', () => {
  it('classifies the audit subset exactly as doc 05 §4 lists it', () => {
    const audit = Object.entries(USER_EVENT_CATALOG)
      .filter(([, entry]) => entry.classification === 'audit')
      .map(([type]) => type)
      .sort();

    assert.deepEqual(audit, [
      'user.account.deactivated',
      'user.account.deletion_requested',

      'user.account.erased',
      'user.account.restored',
      'user.phone.changed',
    ]);
  });

  it('keeps a profile edit out of the audit class (doc 05 §4)', () => {
    assert.equal(USER_EVENT_CATALOG['user.profile.updated']?.classification, 'domain');
    assert.equal(USER_EVENT_CATALOG['user.profile.created']?.classification, 'domain');
  });

  it('treats a change request as observability, since no state changed yet', () => {
    assert.equal(
      USER_EVENT_CATALOG['user.phone.change_requested']?.classification,
      'observability',
    );
  });

  it('stamps every event with this module as the producer (doc 05 §2)', () => {
    assert.equal(USER_PRODUCER, 'users');
    for (const type of Object.keys(USER_EVENT_CATALOG) as UserEventType[]) {
      assert.equal(userEvent(type, { subjectUserId: 'u1' }).producer, 'users', type);
    }
  });

  it('names every event under the user.* namespace (doc 05 §2)', () => {
    for (const type of Object.keys(USER_EVENT_CATALOG)) {
      assert.ok(type.startsWith('user.'), `${type} must live under user.*`);
    }
  });

  it('defaults the aggregate id to the subject user', () => {
    const event = userEvent('user.profile.updated', { subjectUserId: 'u1' });
    assert.equal(event.aggregateId, 'u1');
    assert.equal(event.aggregateType, 'user');
  });

  it('refuses an event type it does not define — an unlisted event is a contract breach', () => {
    assert.throws(
      () => userEvent('user.profile.deleted' as UserEventType, {}),
      /Unknown USER event type/,
    );
  });
});
