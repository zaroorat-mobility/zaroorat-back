import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AUTH_EVENT_CATALOG, authEvent } from '../../../src/modules/auth/events/catalog.js';

// Locks the doc 06 catalog: every type resolves a valid classification + aggregate
// kind, the audit subset (§6) is durable, and authEvent fills the envelope inputs.
describe('AUTH event catalog (doc 06 §4–§6)', () => {
  it('classifies every entry as a known delivery class', () => {
    for (const [type, entry] of Object.entries(AUTH_EVENT_CATALOG)) {
      assert.ok(
        ['audit', 'domain', 'observability'].includes(entry.classification),
        `${type} has an invalid classification`,
      );
      assert.ok(entry.aggregateType.length > 0, `${type} missing aggregateType`);
    }
  });

  it('marks the doc 06 §6 audit subset as durable (audit), not observability', () => {
    const auditSubset = [
      'auth.login.succeeded',
      'auth.session.revoked',
      'auth.refresh.reuse_detected',
      'account.suspended',
      'account.reactivated',
      'account.role.granted',
    ];
    for (const type of auditSubset) {
      assert.equal(AUTH_EVENT_CATALOG[type]?.classification, 'audit', `${type} must be audit`);
    }
  });

  it('keeps the noisy hot-path signals as observability (best-effort)', () => {
    for (const type of ['auth.otp.requested', 'auth.otp.sent', 'auth.login.failed']) {
      assert.equal(AUTH_EVENT_CATALOG[type]?.classification, 'observability');
    }
  });
});

describe('authEvent() builder', () => {
  it('fills classification + aggregateType from the catalog', () => {
    const input = authEvent('auth.session.created', { subjectUserId: 'u1', sessionId: 's1' });
    assert.equal(input.type, 'auth.session.created');
    assert.equal(input.classification, 'audit');
    assert.equal(input.aggregateType, 'session');
  });

  it('defaults aggregateId to the subject user when not overridden', () => {
    const input = authEvent('account.suspended', { subjectUserId: 'u9' });
    assert.equal(input.aggregateId, 'u9');
  });

  it('lets a non-user aggregate override the aggregateId', () => {
    const input = authEvent('auth.device.revoked', { aggregateId: 'dev-1', subjectUserId: 'u1' });
    assert.equal(input.aggregateId, 'dev-1');
  });

  it('throws on an unknown event type (catalog is the closed source of truth)', () => {
    assert.throws(() => authEvent('auth.made.up', {}), /Unknown AUTH event type/);
  });

  it('defaults optional correlation fields to null and data to an empty object', () => {
    const input = authEvent('auth.otp.requested', {});
    assert.equal(input.subjectUserId, null);
    assert.equal(input.sessionId, null);
    assert.equal(input.requestId, null);
    assert.deepEqual(input.data, {});
  });
});
