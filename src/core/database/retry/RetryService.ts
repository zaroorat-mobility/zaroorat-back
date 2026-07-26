/**
 * Structured error codes that are safe to retry.
 *
 * Prisma: P2024 (pool exhausted), P2034 (write conflict / deadlock)
 * pg / Node.js: ECONNRESET, ECONNREFUSED, ETIMEDOUT
 */
const TRANSIENT_ERROR_CODES = new Set([
  'P2024',
  'P2034',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

export class RetryService {
  /**
   * Executes an operation with exponential backoff and full jitter.
   * Only retries on known transient errors — never on fatal errors
   * such as authentication failures or constraint violations.
   *
   * Full jitter (delay = random(0, ceiling)) desynchronises retries across
   * Kubernetes pod replicas, preventing a thundering herd against the database
   * during outages or rolling restarts.
   */
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

        if (attempt >= maxRetries) {
          throw error;
        }

        if (this.isTransientError(error)) {
          const ceiling = initialDelayMs * Math.pow(2, attempt - 1);
          const delay = Math.random() * ceiling;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw new Error('Unreachable: retry loop exhausted without resolution');
  }

  private isTransientError(error: unknown): boolean {
    const err = error as Record<string, unknown> | undefined;

    if (err?.code && typeof err.code === 'string' && TRANSIENT_ERROR_CODES.has(err.code)) {
      return true;
    }

    if (err?.errno && typeof err.code === 'string' && TRANSIENT_ERROR_CODES.has(err.code)) {
      return true;
    }

    return false;
  }
}
