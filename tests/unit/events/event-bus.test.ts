import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventBus } from '../../../src/core/events/EventBus.js';
import type { EventEnvelope } from '../../../src/core/events/types.js';

const envelope = (type: string): EventEnvelope => ({
  eventId: 'e-1',
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  producer: 'auth',
  subject: { userId: 'u1' },
  correlation: { requestId: null, sessionId: null },
  data: {},
});

// The in-process bus (doc 06 §2): typed + wildcard delivery, and a failing
// subscriber must never break delivery to the others.
describe('EventBus', () => {
  it('delivers to a type-specific subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('auth.login.succeeded', (e) => {
      seen.push(e.type);
    });

    bus.emit(envelope('auth.login.succeeded'));
    bus.emit(envelope('auth.login.failed'));

    assert.deepEqual(seen, ['auth.login.succeeded']);
  });

  it('delivers every event to an onAny subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.onAny((e) => {
      seen.push(e.type);
    });

    bus.emit(envelope('auth.otp.sent'));
    bus.emit(envelope('auth.session.revoked'));

    assert.deepEqual(seen, ['auth.otp.sent', 'auth.session.revoked']);
  });

  it('isolates a throwing subscriber so others still receive the event', () => {
    const bus = new EventBus();
    let reached = false;
    bus.on('auth.session.created', () => {
      throw new Error('bad subscriber');
    });
    bus.on('auth.session.created', () => {
      reached = true;
    });

    assert.doesNotThrow(() => bus.emit(envelope('auth.session.created')));
    assert.equal(reached, true);
  });
});
