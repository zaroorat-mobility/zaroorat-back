import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '../../../src/generated/prisma/index.js';
import { PrismaErrorMapper } from '../../../src/core/database/errors/PrismaErrorMapper.js';
import { ConnectionError } from '../../../src/core/database/errors/DatabaseError.js';
import { RetryService } from '../../../src/core/database/retry/RetryService.js';

/// The outage this guards: a momentary loss of the database at boot killed the
/// process outright. `verifyConnection` mapped the driver error into a
/// DatabaseError, which carries no `code`, and RetryService only ever looked at
/// `code` — so nothing was retried and startup crashed on a blip it should have
/// ridden out.
function closedConnection(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `N/A`.', {
    code: 'P2010',
    clientVersion: 'test',
    meta: {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          kind: 'GenericJs',
          originalMessage: 'Server has closed the connection.',
        },
      },
    },
  });
}

describe('a lost database connection', () => {
  it('is mapped as a connection failure, not a generic database fault', () => {
    const mapped = PrismaErrorMapper.mapError(closedConnection(), 'Database Verification');
    assert.ok(mapped instanceof ConnectionError, `got ${mapped.constructor.name}`);
  });

  it('maps the server-shutdown SQLSTATE a failover produces', () => {
    const mapped = PrismaErrorMapper.mapError(
      new Prisma.PrismaClientKnownRequestError('Raw query failed', {
        code: 'P2010',
        clientVersion: 'test',
        meta: {
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: { originalCode: '57P01', originalMessage: 'terminating connection' },
          },
        },
      }),
    );
    assert.ok(mapped instanceof ConnectionError);
  });

  it('is recognised as transient once mapped', () => {
    const retry = new RetryService();
    const mapped = PrismaErrorMapper.mapError(closedConnection(), 'Database Verification');
    assert.equal(retry.isTransientError(mapped), true);
  });

  it('is retried rather than thrown on the first attempt', async () => {
    const retry = new RetryService();
    let calls = 0;
    const result = await retry.executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw PrismaErrorMapper.mapError(closedConnection(), 'boot');
        return 'connected';
      },
      5,
      1,
    );
    assert.equal(result, 'connected');
    assert.equal(calls, 3, 'it kept trying until the database came back');
  });

  it('still fails fast on a fault retrying cannot fix', async () => {
    const retry = new RetryService();
    let calls = 0;
    await assert.rejects(
      retry.executeWithRetry(async () => {
        calls++;
        throw new Error('relation "users" does not exist');
      }, 5),
      /does not exist/,
    );
    assert.equal(calls, 1, 'a schema fault is not retried');
  });

  it('gives up after the budget so a dead database is not waited on forever', async () => {
    const retry = new RetryService();
    let calls = 0;
    await assert.rejects(
      retry.executeWithRetry(
        async () => {
          calls++;
          throw PrismaErrorMapper.mapError(closedConnection(), 'boot');
        },
        4,
        1,
      ),
    );
    assert.equal(calls, 4);
  });
});
