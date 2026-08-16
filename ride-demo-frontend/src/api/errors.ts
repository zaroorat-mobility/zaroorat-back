import type { ValidationIssue } from './types.ts';

/**
 * Normalized failure from the API layer. Every rejection from the client is an
 * ApiError, except caller-initiated aborts, which propagate untouched so
 * TanStack Query can recognise a cancellation.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  /** Backend `error.code`, or a client-side code for transport failures. */
  readonly code: string;
  /** `error.requestId` from the backend. Absent on transport and 404 errors. */
  readonly requestId: string | null;
  /** Present when `code === 'VALIDATION'`. */
  readonly validationErrors: ValidationIssue[];
  /** Backend `error.retryAfterSec`, sent with rate-limit and OTP-lock errors. */
  readonly retryAfterSec: number | null;
  /** Raw `error.details`, kept for the debug view. */
  readonly details: unknown;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string | null;
    validationErrors?: ValidationIssue[];
    retryAfterSec?: number | null;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.validationErrors = init.validationErrors ?? [];
    this.retryAfterSec = init.retryAfterSec ?? null;
    this.details = init.details;
  }

  /** True when no response was received (offline, DNS, CORS, timeout). */
  get isTransportError(): boolean {
    return this.status === 0;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * `details` arrives in one of three formats depending on which layer rejected:
 *
 *   Fastify schema  { instancePath: '/phoneNumber', message: 'must match …' }
 *   Zod, auth       { path: ['phoneNumber'], message: 'phoneNumber must be …' }
 *   users module    { field: 'dateOfBirth', code: 'AGE_BELOW_MINIMUM' }
 *
 * The third carries a machine code instead of a sentence, so it is surfaced as
 * `code` and the caller decides how to word it.
 */
function toValidationIssues(details: unknown): ValidationIssue[] {
  if (!Array.isArray(details)) return [];

  return details.flatMap((entry): ValidationIssue[] => {
    const issue = asRecord(entry);
    if (!issue) return [];

    // users module: { field, code, limit? }
    if (typeof issue.field === 'string' && typeof issue.code === 'string') {
      return [{ path: issue.field, code: issue.code, message: issue.code }];
    }

    if (typeof issue.message !== 'string') return [];

    let path = '';
    if (typeof issue.instancePath === 'string') {
      path = issue.instancePath.replace(/^\//, '').replaceAll('/', '.');
    } else if (Array.isArray(issue.path)) {
      path = issue.path.join('.');
    }

    return [{ path, message: issue.message }];
  });
}

/**
 * Builds an ApiError from a failed response. `body` is whatever was parsed —
 * the standard error envelope, the unmatched-route body, plain text, or null
 * when the response had no readable body.
 */
export function toApiError(status: number, body: unknown, statusText: string): ApiError {
  const envelope = asRecord(asRecord(body)?.error);

  if (envelope && typeof envelope.message === 'string') {
    return new ApiError({
      status,
      code: typeof envelope.code === 'string' ? envelope.code : 'UNKNOWN',
      message: envelope.message,
      requestId: typeof envelope.requestId === 'string' ? envelope.requestId : null,
      validationErrors: toValidationIssues(envelope.details),
      retryAfterSec: typeof envelope.retryAfterSec === 'number' ? envelope.retryAfterSec : null,
      details: envelope.details,
    });
  }

  // Unmatched route: { success: false, message } from setNotFoundHandler.
  const unmatched = asRecord(body);
  if (unmatched && unmatched.success === false && typeof unmatched.message === 'string') {
    return new ApiError({ status, code: 'NOT_FOUND', message: unmatched.message });
  }

  return new ApiError({
    status,
    code: 'UNKNOWN',
    message: typeof body === 'string' && body.trim() ? body : statusText || `HTTP ${status}`,
    details: body,
  });
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
