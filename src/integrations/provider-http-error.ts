/// A failed upstream call, carrying the status the provider actually returned.
///
/// The map clients used to throw a bare `Error` whose message happened to
/// contain the status. Everything downstream collapsed to a single 503, so a
/// revoked key, an exhausted quota and a genuine provider outage were
/// indistinguishable — the one distinction an operator most needs at 3am, and
/// the reason `MapProviderAuthError` / `MapProviderQuotaError` existed with
/// nothing ever throwing them.
///
/// This lives in `integrations/` rather than `modules/location/errors/` on
/// purpose: the HTTP clients are shared by the admin health checks and the
/// location module, and neither should have to import the other's error types
/// to report a 429. `MapProviderService.classifyProviderError` maps it.
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider} API error (${status})${body ? `: ${body}` : ''}`);
    this.name = 'ProviderHttpError';
  }

  /** Credential rejected — revoked, wrong, or lacking the required API scope. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** Rate limited or out of quota. Distinct from an outage: retrying later works. */
  get isQuotaFailure(): boolean {
    return this.status === 429;
  }
}

/// True for the `TimeoutError` that `AbortSignal.timeout` raises, and for the
/// `AbortError` some runtimes raise instead.
export function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/// Worth a second attempt: a timeout, a connection-level failure, or a 5xx.
///
/// Deliberately excludes 429. Retrying a rate limit within a couple of hundred
/// milliseconds spends the caller's remaining budget faster and is what turns a
/// throttle into an outage; it surfaces as `MapProviderQuotaError` instead.
/// 4xx other than 429 is a request or credential problem — replaying it changes
/// nothing.
export function isRetryableProviderError(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (error instanceof ProviderHttpError) return error.status >= 500;
  // A transport-level failure (DNS, refused connection, socket reset) arrives as
  // a TypeError from fetch with no status at all.
  return error instanceof TypeError;
}

/// Run `attempt` up to `attempts` times, backing off between tries.
///
/// Only for idempotent requests — a GET of a route, a matrix, a geocode. The map
/// clients had no retry at all, so a single dropped packet on the way to Ola
/// failed a fare quote outright. Backoff is exponential from `baseDelayMs` with
/// jitter, so a provider blip does not turn every in-flight request into a
/// synchronised retry burst.
export async function retryIdempotent<T>(
  attempt: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 150;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const isLast = i === attempts - 1;
      if (isLast || !isRetryableProviderError(error)) throw error;
      const backoff = baseDelayMs * 2 ** i;
      // Full jitter: spread retries across the window rather than stacking them
      // at its edge.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * backoff));
    }
  }
  throw lastError;
}
