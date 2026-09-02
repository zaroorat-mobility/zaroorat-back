import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Prisma } from '../../../src/generated/prisma/index.js';
import { PrismaErrorMapper } from '../../../src/core/database/errors/PrismaErrorMapper.js';
import {
  DatabaseError,
  UniqueConstraintError,
} from '../../../src/core/database/errors/DatabaseError.js';

/// Every insert into a table with a PostGIS geography column goes through
/// `$executeRaw`, because Prisma cannot express that column — so the unique
/// indexes guarding those tables can only ever raise P2010, never P2002. The
/// mapper had no P2010 case, so those violations arrived as a bare
/// `DatabaseError` with no `code` and no `statusCode`, and every route handler
/// in the codebase could only report them as 500.
///
/// The `meta` shapes below are copied from a real violation raised through the
/// application's own client (Prisma 7, driver adapter).
function rawFailure(meta: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: meta as Record<string, unknown>,
  });
}

function uniqueViolation(constraint: string): unknown {
  return {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        kind: 'UniqueConstraintViolation',
        originalCode: '23505',
        originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
        constraint: { fields: ['customer_id'] },
      },
    },
  };
}

describe('PrismaErrorMapper', () => {
  describe('a unique violation from a raw statement (M-10)', () => {
    it('is recognised as a unique constraint failure, not a generic fault', () => {
      const mapped = PrismaErrorMapper.mapError(
        rawFailure(uniqueViolation('ride_requests_active_customer_key')),
      );
      assert.ok(mapped instanceof UniqueConstraintError);
    });

    it('names the index, so a caller can tell which rule it broke', () => {
      const mapped = PrismaErrorMapper.mapError(
        rawFailure(uniqueViolation('ride_requests_active_customer_key')),
      );
      assert.match(mapped.message, /ride_requests_active_customer_key/);
    });

    it('falls back to the columns when Postgres named no constraint', () => {
      const mapped = PrismaErrorMapper.mapError(
        rawFailure({
          driverAdapterError: {
            cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['customer_id'] } },
          },
        }),
      );
      assert.ok(mapped instanceof UniqueConstraintError);
      assert.match(mapped.message, /customer_id/);
    });

    it('recognises the SQLSTATE even without the adapter’s own label', () => {
      const mapped = PrismaErrorMapper.mapError(
        rawFailure({ driverAdapterError: { cause: { originalCode: '23505' } } }),
      );
      assert.ok(mapped instanceof UniqueConstraintError);
    });
  });

  describe('other raw failures stay generic', () => {
    it('leaves a different SQLSTATE alone', () => {
      const mapped = PrismaErrorMapper.mapError(
        rawFailure({
          driverAdapterError: {
            cause: { kind: 'ForeignKeyViolation', originalCode: '23503' },
          },
        }),
      );
      assert.ok(mapped instanceof DatabaseError);
      assert.ok(!(mapped instanceof UniqueConstraintError));
    });

    it('leaves a raw failure with no adapter detail alone', () => {
      const mapped = PrismaErrorMapper.mapError(rawFailure(undefined));
      assert.ok(mapped instanceof DatabaseError);
      assert.ok(!(mapped instanceof UniqueConstraintError));
    });
  });

  it('still maps P2002 the way it always did', () => {
    const mapped = PrismaErrorMapper.mapError(
      new Prisma.PrismaClientKnownRequestError('Unique failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['phone'] },
      }),
    );
    assert.ok(mapped instanceof UniqueConstraintError);
    assert.match(mapped.message, /phone/);
  });

  /// PATCH /users/me/profile with an email another account already holds
  /// produced a P2002 whose `meta.target` is empty under the driver adapter,
  /// so the mapper reported "unknown" and the caller could not tell which
  /// field collided.
  it('names the field on a P2002 that only carries adapter detail', () => {
    const mapped = PrismaErrorMapper.mapError(
      new Prisma.PrismaClientKnownRequestError('Unique failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: {
          modelName: 'User',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              kind: 'UniqueConstraintViolation',
              originalCode: '23505',
              originalMessage: 'duplicate key value violates unique constraint "users_email_key"',
              constraint: { fields: ['email'] },
            },
          },
        },
      }),
    );
    assert.ok(mapped instanceof UniqueConstraintError);
    assert.match(mapped.message, /users_email_key/);
    assert.doesNotMatch(mapped.message, /unknown/);
  });

  it('still says unknown when there is nothing to name', () => {
    const mapped = PrismaErrorMapper.mapError(
      new Prisma.PrismaClientKnownRequestError('Unique failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: {},
      }),
    );
    assert.ok(mapped instanceof UniqueConstraintError);
    assert.match(mapped.message, /unknown/);
  });
});
