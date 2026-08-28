import { Prisma } from '../../../generated/prisma';
import {
  DatabaseError,
  ConnectionError,
  RecordNotFoundError,
  UniqueConstraintError,
} from './DatabaseError';
/// Postgres SQLSTATE for a unique violation.
const UNIQUE_VIOLATION = '23505';

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
      switch (error.code) {
        case 'P2000':
          return new DatabaseError(`Value too long for column`, error);
        case 'P2001':
          return new RecordNotFoundError(context || 'Record not found in condition', error);
        case 'P2002':
          return new UniqueConstraintError(
            (error.meta?.target as string[])?.join(', ') || 'unknown',
            error,
          );
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
      return new DatabaseError(error.message, error);
    }
    return new DatabaseError('An unknown database error occurred', error);
  }
}
