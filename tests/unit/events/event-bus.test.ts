import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventBus } from '../../../src/core/events/EventBus.js';
import type { EventEnvelope } from '../../../src/core/events/types.js';

const envelope = (type: string): EventEnvelope => ({
  eventId: 'e-1',
  type,
  version: 1,
  envelopeVersion: 1,
  occurredAt: new Date().toISOString(),
  producer: 'auth',
  subject: { userId: 'u1' },
  correlation: { requestId: null, sessionId: null },
  data: {},
});

describe('EventBus', () => {
  it('delivers to a type-specific subscriber', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('auth.login.succeeded', (e) => {
      seen.push(e.type);
    });

    await bus.emit(envelope('auth.login.succeeded'));
    await bus.emit(envelope('auth.login.failed'));

    assert.deepEqual(seen, ['auth.login.succeeded']);
  });

  it('delivers every event to an onAny subscriber', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.onAny((e) => {
      seen.push(e.type);
    });

    await bus.emit(envelope('auth.otp.sent'));
    await bus.emit(envelope('auth.session.revoked'));

    assert.deepEqual(seen, ['auth.otp.sent', 'auth.session.revoked']);
  });

  it('isolates a throwing subscriber so others still receive the event', async () => {
    const bus = new EventBus();
    let reached = false;
    bus.on('auth.session.created', () => {
      throw new Error('bad subscriber');
    });
    bus.on('auth.session.created', () => {
      reached = true;
    });

    const result = await bus.emit(envelope('auth.session.created'));

    assert.equal(reached, true);
    assert.equal(result.delivered, 1);
    assert.equal(result.failures.length, 1);
  });

  it('reports an async handler rejection instead of swallowing it', async () => {
    const bus = new EventBus();
    bus.on('auth.login.succeeded', async () => {
      await Promise.resolve();
      throw new Error('consumer exploded');
    });

    const result = await bus.emit(envelope('auth.login.succeeded'));

    assert.equal(result.delivered, 0);
    assert.equal(result.failures.length, 1);
    assert.match((result.failures[0] as Error).message, /consumer exploded/);
  });

  it('does not resolve until a slow handler has finished', async () => {
    const bus = new EventBus();
    let finished = false;
    bus.on('auth.session.created', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });

    await bus.emit(envelope('auth.session.created'));

    assert.equal(finished, true);
  });

  it('reports success when nobody is listening', async () => {
    const bus = new EventBus();
    const result = await bus.emit(envelope('auth.otp.sent'));

    assert.deepEqual(result, { delivered: 0, failures: [] });
  });

  it('stops delivering once a subscription is removed', async () => {
    const bus = new EventBus();
    let calls = 0;
    const off = bus.on('auth.otp.sent', () => {
      calls += 1;
    });

    await bus.emit(envelope('auth.otp.sent'));
    off();
    await bus.emit(envelope('auth.otp.sent'));

    assert.equal(calls, 1);
    assert.equal(bus.listenerCount('auth.otp.sent'), 0);
  });
});
