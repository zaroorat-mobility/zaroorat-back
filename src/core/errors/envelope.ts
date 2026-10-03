import { DatabaseError } from '../database/errors/DatabaseError.js';

export interface ErrorEnvelope {
  error: {
    code: string;
    messageKey: string;
    message: string;
    requestId: string;
    details?: unknown;
    retryAfterSec?: number;
    [key: string]: unknown;
  };
}
export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    error: {
      code,
      messageKey: `error.${code.toLowerCase()}`,
      message,
      requestId,
      ...extra,
    },
  };
}
/// For a controller whose `catch` answers 400 with the error's message: only a failure the
/// client caused may be answered that way. A database error, or anything carrying a 5xx
/// status (a missing audit actor), is the server's — rethrown to the global handler, which
/// logs it and answers a masked 500. Raw database text can quote row values; it never
/// reaches the client, and a failed write is never reported as the client's mistake.
export function rethrowServerFault(error: unknown): void {
  if (error instanceof DatabaseError) throw error;
  if (error instanceof Error && error.name.startsWith('PrismaClient')) throw error;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && status >= 500) throw error;
}

export interface CodedError {
  code: string;
  statusCode: number;
  message: string;
  details?: unknown;
}
export function isCodedError(err: unknown): err is CodedError {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as Partial<CodedError>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.statusCode === 'number' &&
    typeof candidate.message === 'string'
  );
}
