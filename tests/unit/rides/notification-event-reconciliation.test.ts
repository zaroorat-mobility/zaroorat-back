import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '../../../src/generated/prisma/index.js';
import { ConnectionError } from '../../../src/core/database/errors/DatabaseError.js';
import type { PublishedOutboxEvent } from '../../../src/core/events/OutboxRepository.js';
import {
  RECONCILED_EVENT_TYPES,
  RECONCILE_EVENT_LOOKBACK_MS,
  classifyFailure,
  eventExpiry,
  parseCursor,
  parseEnvelope,
  resolveReconciliationMode,
  resolveStart,
} from '../../../src/modules/rides/jobs/notification-event-reconciliation.job.js';

/// F3 S6 — the reconciliation job's pure rules. The algorithm itself runs against
/// real PostgreSQL and Redis in
/// tests/integration/notification-event-reconciliation-postgres.test.ts.

const T = Date.parse('2026-09-26T12:00:00.000Z');
const HOUR = 3_600_000;

function known(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('simulated', { code, clientVersion: 'test' });
}

describe('which events are reconciled', () => {
  it('the nine notification events other than ride offers', () => {
    assert.deepEqual([...RECONCILED_EVENT_TYPES].sort(), [
      'payment.ride.collected',
      'payment.ride.collection_failed',
      'ride.accepted',
      'ride.cancelled',
      'ride.completed',
      'ride.driver_arrived',
      'ride.driver_arriving',
      'ride.request.expired',
      'ride.started',
    ]);
  });

  it('never looks back further than the one-hour transactional TTL', () => {
    assert.equal(RECONCILE_EVENT_LOOKBACK_MS, HOUR);
  });
});

describe('eventExpiry — the existing TTL rules, from event creation', () => {
  it('a transactional event is recoverable 1ms short of an hour and expired at exactly an hour', () => {
    for (const type of RECONCILED_EVENT_TYPES) {
      assert.equal(eventExpiry(type, {}, new Date(T - HOUR + 1), new Date(T)), null, type);
      assert.equal(eventExpiry(type, {}, new Date(T - HOUR), new Date(T)), 'ttl_elapsed', type);
    }
  });

  it('an offer is judged by its own window: 0ms left is expired, 1ms left is not', () => {
    const created = new Date(T - 1_000);
    const at = (ms: number) => ({ expiresAt: new Date(T + ms).toISOString() });
    assert.equal(
      eventExpiry('ride.dispatch.offered', at(0), created, new Date(T)),
      'offer_expired',
    );
    assert.equal(eventExpiry('ride.dispatch.offered', at(1), created, new Date(T)), null);
  });

  it('an offer with no usable window falls back to the 45s class TTL', () => {
    assert.equal(eventExpiry('ride.dispatch.offered', {}, new Date(T - 44_999), new Date(T)), null);
    assert.equal(
      eventExpiry('ride.dispatch.offered', {}, new Date(T - 45_000), new Date(T)),
      'ttl_elapsed',
    );
  });
});

describe('classifyFailure — through PrismaErrorMapper and RetryService', () => {
  it('retries what can succeed later', () => {
    const cases: Array<[unknown, string]> = [
      [new ConnectionError('socket closed'), 'connection'],
      [known('P1001'), 'connection'],
      [known('P2024'), 'connection'],
      [known('P2034'), 'write_conflict'],
      [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'transient'],
    ];
    for (const [err, reason] of cases) {
      assert.deepEqual(classifyFailure(err), { result: 'transient', reason }, String(err));
    }
  });

  it('never retries schema, data, constraint or programming errors', () => {
    const cases: Array<[unknown, string]> = [
      [known('P2003'), 'foreign_key'],
      [known('P2000'), 'value_too_long'],
      [known('P2002'), 'unique_violation'],
      [known('P2004'), 'constraint'],
      [known('P2023'), 'invalid_data'],
      [
        new Prisma.PrismaClientValidationError('bad argument', { clientVersion: 'test' }),
        'validation',
      ],
      [new TypeError('x is undefined'), 'programming'],
    ];
    for (const [err, reason] of cases) {
      assert.deepEqual(classifyFailure(err), { result: 'permanent', reason }, String(err));
    }
  });
});

describe('parseEnvelope — the outbox payload, as the relay emitted it', () => {
  const row = (payload: unknown): PublishedOutboxEvent => ({
    id: 'o-1',
    eventId: 'e-1',
    eventType: 'ride.started',
    payload,
    createdAt: new Date(T),
    publishedAt: new Date(T),
  });
  const envelope = { eventId: 'e-1', type: 'ride.started', data: { rideId: 'r-1' } };

  it('returns the payload itself', () => {
    const payload = { ...envelope };
    assert.strictEqual(parseEnvelope(row(payload)), payload);
  });

  it('refuses a payload whose ids do not match the row, or that has no data — never normalising it', () => {
    for (const payload of [
      null,
      'text',
      { ...envelope, eventId: 'e-2' },
      { ...envelope, type: 'ride.completed' },
      { ...envelope, data: null },
      { eventId: 'e-1', type: 'ride.started' },
    ]) {
      assert.equal(parseEnvelope(row(payload)), null, JSON.stringify(payload));
    }
  });
});

describe('cursor', () => {
  const id = '0192c3a1-0000-7000-8000-000000000001';

  it('round-trips a stored cursor and rejects anything else', () => {
    const stored = JSON.stringify({ publishedAt: new Date(T).toISOString(), id });
    assert.deepEqual(parseCursor(stored), { publishedAt: new Date(T), id });
    for (const raw of [null, '', 'not json', '{}', JSON.stringify({ publishedAt: 'x', id })]) {
      assert.equal(parseCursor(raw), null, String(raw));
    }
    assert.equal(
      parseCursor(JSON.stringify({ publishedAt: new Date(T).toISOString(), id: 'x' })),
      null,
    );
  });

  it('starts at the stored cursor unless it is missing or older than the lookback floor', () => {
    const floor = new Date(T - HOUR);
    const nil = '00000000-0000-0000-0000-000000000000';
    const inside = { publishedAt: new Date(T - 60_000), id };
    const atFloor = { publishedAt: floor, id };
    assert.deepEqual(resolveStart(inside, floor), inside);
    assert.deepEqual(resolveStart(atFloor, floor), atFloor);
    assert.deepEqual(resolveStart({ publishedAt: new Date(T - HOUR - 1), id }, floor), {
      publishedAt: floor,
      id: nil,
    });
    assert.deepEqual(resolveStart(null, floor), { publishedAt: floor, id: nil });
  });
});

describe('mode', () => {
  it('defaults to dry-run, accepts on/off/dry-run, and treats anything else as off', () => {
    assert.equal(resolveReconciliationMode(undefined), 'dry-run');
    assert.equal(resolveReconciliationMode(''), 'dry-run');
    for (const mode of ['on', 'off', 'dry-run'] as const) {
      assert.equal(resolveReconciliationMode(mode), mode);
    }
    for (const raw of ['ON', 'true', '1', 'yes']) {
      assert.equal(resolveReconciliationMode(raw), 'off', raw);
    }
  });
});
