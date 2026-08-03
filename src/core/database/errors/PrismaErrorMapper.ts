import { Prisma } from '../../../generated/prisma';
import {
  DatabaseError,
  ConnectionError,
  RecordNotFoundError,
  UniqueConstraintError,
} from './DatabaseError';

export class PrismaErrorMapper {
  /**
   * True when the error came from Prisma and is therefore worth translating.
   *
   * `mapError` wraps *anything* it is handed, which is correct at a call site
   * that only ever sees driver failures. A call site that also runs application
   * code — a transaction callback — must ask this first, or a domain error thrown
   * inside the callback is rewritten as a `DatabaseError` and a deliberate 403
   * reaches the client as a 500.
   */
  public static isPrismaError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError ||
      error instanceof Prisma.PrismaClientRustPanicError ||
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientValidationError
    );
  }

  /**
   * Translates a Prisma-specific error into a domain DatabaseError.
   */
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
