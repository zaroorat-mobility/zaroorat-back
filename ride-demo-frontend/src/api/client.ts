import { env } from '../config/env.ts';
import { ApiError, toApiError } from './errors.ts';
import type { HttpMethod, RequestDiagnostic, RequestOptions } from './types.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Extension point for the future authentication module: it calls
 * `setAuthTokenProvider(() => accessToken)` once, and every request picks the
 * token up from there. No token is stored, read or persisted in this layer.
 *
 * The backend expects `Authorization: Bearer <jwt>` (src/modules/auth/plugins/
 * auth.plugin.ts) and puts the refresh token in a request body rather than a
 * cookie, so no credentialed-fetch mode is needed.
 */
type AuthTokenProvider = () => string | null | undefined;

let authTokenProvider: AuthTokenProvider = () => null;

export function setAuthTokenProvider(provider: AuthTokenProvider): void {
  authTokenProvider = provider;
}

/**
 * Second extension point, for recovering from an expired access token. The auth
 * module registers a handler that refreshes the session; returning `true` makes
 * the client replay the original request exactly once.
 *
 * The client owns the "retry at most once" rule so no caller can loop, and the
 * refresh call itself must pass `skipAuthRetry` so it can never recurse.
 */
type UnauthorizedHandler = (error: ApiError) => Promise<boolean>;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

/**
 * Diagnostics sink. Subscribers receive metadata only — never headers, never
 * bodies — so tokens and OTP codes cannot reach a log by construction.
 */
type DiagnosticListener = (entry: RequestDiagnostic) => void;

const listeners = new Set<DiagnosticListener>();

export function onRequestDiagnostic(listener: DiagnosticListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(entry: RequestDiagnostic): void {
  if (env.isDev) {
    const status = entry.status ?? 'ERR';
    console.debug(
      `[api] ${entry.method} ${entry.path} → ${status} (${entry.durationMs}ms)`,
      entry.requestId ? `req:${entry.requestId}` : '',
    );
  }
  for (const listener of listeners) listener(entry);
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  // Relative-URL resolution against the configured base, so a base with a path
  // prefix survives and `//` cannot appear in the middle.
  const url = new URL(path.replace(/^\//, ''), `${env.apiBaseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Combines the caller's signal with the timeout; either one aborts the fetch. */
function buildSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined;

  const text = await response.text();
  if (!text) return undefined;

  // Error pages and proxy responses are not always JSON; hand back the text so
  // the message survives into the ApiError.
  if (!response.headers.get('content-type')?.includes('json')) return text;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
  options: RequestOptions = {},
  isRetry = false,
): Promise<T> {
  // Fastify is configured with `requestIdHeader: 'x-request-id'` and adopts an
  // incoming value, so sending one makes successful requests traceable too —
  // the backend only echoes its request id inside error bodies.
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();

  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-request-id': requestId,
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    ...options.headers,
  };

  const token = authTokenProvider();
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: buildSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    // A caller-initiated abort is not a failure — let it through untouched so
    // TanStack Query reads it as a cancellation rather than an error state.
    if (options.signal?.aborted) throw cause;

    const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
    emit({ method, path, status: null, durationMs: elapsed(startedAt), requestId, ok: false });
    throw new ApiError({
      status: 0,
      code: timedOut ? 'TIMEOUT' : 'NETWORK',
      message: timedOut
        ? `Request timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : 'Could not reach the backend',
      requestId,
      details: cause,
    });
  }

  const parsed = await parseBody(response);
  const duration = elapsed(startedAt);

  if (!response.ok) {
    const error = toApiError(response.status, parsed, response.statusText);
    emit({
      method,
      path,
      status: response.status,
      durationMs: duration,
      requestId: error.requestId ?? requestId,
      ok: false,
    });

    if (response.status === 401 && unauthorizedHandler && !options.skipAuthRetry && !isRetry) {
      if (await unauthorizedHandler(error)) {
        return request<T>(method, path, body, options, true);
      }
    }

    throw error;
  }

  emit({ method, path, status: response.status, durationMs: duration, requestId, ok: true });
  return parsed as T;
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/**
 * The single HTTP entry point. Returns the parsed body exactly as the backend
 * sent it — unwrapping `{ data }` is each module's job, because only some of
 * them use it (see DataEnvelope in types.ts).
 */
export const apiClient = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};
