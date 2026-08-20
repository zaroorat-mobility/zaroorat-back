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
