/**
 * Shapes taken from the backend implementation, not from documentation.
 * See README "Backend contract" for where each one was found.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The backend does NOT use one success envelope.
 *
 *   auth / users / files / health  ->  the payload itself, unwrapped
 *   rides / drivers / payments     ->  { data: payload }
 *
 * The client therefore returns the parsed body verbatim; each module declares
 * which of the two it gets. Use this type for the second group.
 */
export interface DataEnvelope<T> {
  data: T;
}

/**
 * Error body from `src/core/errors/error-handler.ts` and the per-module
 * `replyAuthError` / `replyFileError` helpers. Every handled error uses it.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    messageKey: string;
    message: string;
    requestId: string;
    retryAfterSec?: number;
    details?: unknown;
  };
}

/**
 * Exception: `setNotFoundHandler` in `src/app/app.ts` answers unmatched routes
 * with this instead, so it carries no code and no requestId.
 */
export interface UnmatchedRouteBody {
  success: false;
  message: string;
}

/** Normalized from any of the three issue formats the backend emits — see errors.ts. */
export interface ValidationIssue {
  /** Dotted field path, e.g. `device.deviceId`. Empty for whole-body errors. */
  path: string;
  /** Human-readable where the backend gave prose; the raw code otherwise. */
  message: string;
  /**
   * Machine code, present only for the users module, which sends
   * `{ field, code }` instead of a sentence (INVALID_FORMAT, MUST_BE_PAST,
   * AGE_BELOW_MINIMUM, NOT_ALLOWED, TOO_LONG, REQUIRED, OUT_OF_RANGE,
   * IMMUTABLE). Modules map it to their own copy.
   */
  code?: string;
}

export interface RequestOptions {
  /** Cancellation from the caller — TanStack Query passes its own signal here. */
  signal?: AbortSignal;
  /** Overrides the client default. */
  timeoutMs?: number;
  /** Appended to the URL; `undefined` and `null` values are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Merged over the generated headers. */
  headers?: Record<string, string>;
  /**
   * Required by state-changing endpoints in auth, files and payments — the
   * backend reads the `Idempotency-Key` header and 409s on a replay in flight.
   */
  idempotencyKey?: string;
  /**
   * Opts out of the refresh-and-retry-once behaviour on 401. Required on the
   * refresh call itself, and on anything that must surface a 401 verbatim.
   */
  skipAuthRetry?: boolean;
}

/** Emitted for every completed request. Carries no headers and no bodies. */
export interface RequestDiagnostic {
  method: HttpMethod;
  path: string;
  status: number | null;
  durationMs: number;
  requestId: string | null;
  ok: boolean;
}
