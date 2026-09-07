import { Prisma } from '../../../generated/prisma';
import {
  DatabaseError,
  ConnectionError,
  RecordNotFoundError,
  UniqueConstraintError,
} from './DatabaseError';
/// Postgres SQLSTATE for a unique violation.
const UNIQUE_VIOLATION = '23505';

/// SQLSTATE class 08 is "connection exception", plus the three server-side
/// shutdown//startup states that present the same way to a client: the socket
/// goes away mid-flight and nothing about the statement was wrong.
const CONNECTION_SQLSTATES = new Set([
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08006', // connection_failure
  '08007', // transaction_resolution_unknown
  '57P01', // admin_shutdown  — failover, restart, `pg_terminate_backend`
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — server still starting up
  '53300', // too_many_connections
]);

/// The driver adapter reports a lost socket as P2010 with no SQLSTATE at all
/// ("Code: `N/A`"), so the message is the only signal left.
const CONNECTION_MESSAGES =
  /server has closed the connection|connection terminated|connection closed|connection reset|socket hang up|econnreset|econnrefused|etimedout|epipe|starting up|shutting down|terminating connection/i;

/// Prisma's own connection-level codes, which never reach the switch below
/// because they are not statement failures.
const CONNECTION_PRISMA_CODES = new Set([
  'P1001', // can't reach database server
  'P1002', // server reached but timed out
  'P1008', // operation timed out
  'P1017', // server has closed the connection
]);

/// Under a driver adapter, Prisma reports a failed raw statement as P2010 and
/// buries the database's own answer in here rather than in `meta.code`.
interface DriverAdapterCause {
  kind?: string;
  originalCode?: string;
  originalMessage?: string;
  constraint?: { fields?: string[] };
}

function driverAdapterCause(meta: unknown): DriverAdapterCause | undefined {
  return (meta as { driverAdapterError?: { cause?: DriverAdapterCause } } | undefined)
    ?.driverAdapterError?.cause;
}

/// The index name if Postgres named one, the columns otherwise — the index name
/// is what a reader can grep for.
function isConnectionFailure(
  error: { code?: string; message?: string },
  cause: DriverAdapterCause | undefined,
): boolean {
  if (error.code && CONNECTION_PRISMA_CODES.has(error.code)) return true;
  if (cause?.originalCode && CONNECTION_SQLSTATES.has(cause.originalCode)) return true;
  return CONNECTION_MESSAGES.test(cause?.originalMessage ?? error.message ?? '');
}

function uniqueTarget(cause: DriverAdapterCause): string {
  return (
    /unique constraint "([^"]+)"/.exec(cause.originalMessage ?? '')?.[1] ??
    cause.constraint?.fields?.join(', ') ??
    'unknown'
  );
}

export class PrismaErrorMapper {
  public static isPrismaError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError ||
      error instanceof Prisma.PrismaClientRustPanicError ||
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientValidationError
    );
  }
  public static mapError(error: unknown, context?: string): Error {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (CONNECTION_PRISMA_CODES.has(error.code)) {
        return new ConnectionError(error.message, error);
      }
      switch (error.code) {
        case 'P2000':
          return new DatabaseError(`Value too long for column`, error);
        case 'P2001':
          return new RecordNotFoundError(context || 'Record not found in condition', error);
        // Under a driver adapter `meta.target` is empty and the violated
        // columns are only in the adapter cause, so a plain P2002 used to
        // report "unknown" — the same burial the P2010 case handles below.
        case 'P2002': {
          const target = (error.meta?.target as string[] | undefined)?.join(', ');
          const cause = driverAdapterCause(error.meta);
          return new UniqueConstraintError(
            target || (cause ? uniqueTarget(cause) : 'unknown'),
            error,
          );
        }
        case 'P2003':
          return new DatabaseError(`Foreign key constraint failed`, error);
        case 'P2004':
          return new DatabaseError(`Constraint failed on database`, error);
        case 'P2014':
          return new DatabaseError(`Change violates required relation`, error);
        // A unique violation raised by a raw statement arrives as P2010, never
        // as P2002 — and every insert into a table carrying a PostGIS geography
        // column goes through `$executeRaw`, because Prisma cannot express one.
        // Without this case those violations fell through to a bare
        // `DatabaseError`, so a partial unique index doing exactly its job
        // (`ride_requests_active_customer_key`) reached the client as an
        // unexplained 500 that no route handler could translate.
        case 'P2010': {
          const cause = driverAdapterCause(error.meta);
          if (
            cause?.kind === 'UniqueConstraintViolation' ||
            cause?.originalCode === UNIQUE_VIOLATION
          ) {
            return new UniqueConstraintError(uniqueTarget(cause), error);
          }
          // A lost socket also arrives here as P2010 with no SQLSTATE. Left as a
          // bare DatabaseError it carried no `code`, so RetryService could not
          // see it was transient and a momentary blip killed the process.
          if (isConnectionFailure(error, cause)) {
            return new ConnectionError(cause?.originalMessage ?? 'Database connection lost', error);
          }
          break;
        }
        case 'P2024':
          return new ConnectionError('Connection pool exhausted / Wait Queue timeout', error);
        case 'P2025':
          return new RecordNotFoundError(context || 'Record not found', error);
        case 'P2034':
          return new DatabaseError('Transaction failed due to write conflict/deadlock', error);
      }
    }
    if (error instanceof Prisma.PrismaClientInitializationError) {
      return new ConnectionError(
        'Failed to initialize Prisma client / Cannot reach database server',
        error,
      );
    }
    if (error instanceof Error) {
      if (isConnectionFailure(error as { code?: string; message?: string }, undefined)) {
        return new ConnectionError(error.message, error);
      }
      return new DatabaseError(error.message, error);
    }
    return new DatabaseError('An unknown database error occurred', error);
  }
}
