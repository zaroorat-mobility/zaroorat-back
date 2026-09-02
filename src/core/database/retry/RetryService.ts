import { ConnectionError } from '../errors/DatabaseError';

const TRANSIENT_ERROR_CODES = new Set([
  'P2024', // connection pool timeout
  'P2034', // write conflict / deadlock
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/// Full jitter with no floor could sleep ~0ms, so three "retries" used to
/// finish inside a millisecond — no help against a database that needs a
/// moment (a checkpoint, a failover, a container still warming up).
const MIN_DELAY_MS = 50;
const MAX_DELAY_MS = 5_000;

export class RetryService {
  public async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    initialDelayMs: number = 100,
  ): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        return await operation();
      } catch (error: unknown) {
        attempt++;
        if (attempt >= maxRetries || !this.isTransientError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, this.delayFor(attempt, initialDelayMs)));
      }
    }
    throw new Error('Unreachable: retry loop exhausted without resolution');
  }

  /// Decorrelated backoff: exponential ceiling, jittered, but never below
  /// MIN_DELAY_MS so a retry is actually a wait.
  private delayFor(attempt: number, initialDelayMs: number): number {
    const ceiling = Math.min(initialDelayMs * Math.pow(2, attempt - 1), MAX_DELAY_MS);
    return Math.max(MIN_DELAY_MS, Math.random() * ceiling);
  }

  public isTransientError(error: unknown): boolean {
    // PrismaErrorMapper wraps a lost connection as ConnectionError and strips
    // the original `code`; matching on `code` alone missed every one of them.
    if (error instanceof ConnectionError) return true;

    const err = error as Record<string, unknown> | undefined;
    if (typeof err?.code === 'string' && TRANSIENT_ERROR_CODES.has(err.code)) return true;
    if (typeof err?.errno === 'string' && TRANSIENT_ERROR_CODES.has(err.errno)) return true;

    // Mapped errors keep the driver's error in `originalError`.
    const original = err?.originalError;
    if (original != null && original !== error) return this.isTransientError(original);

    return false;
  }
}
