const TRANSIENT_ERROR_CODES = new Set([
  'P2024',
  'P2034',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);
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
    if (typeof err?.code === 'string' && TRANSIENT_ERROR_CODES.has(err.code)) {
      return true;
    }
    if (typeof err?.errno === 'string' && TRANSIENT_ERROR_CODES.has(err.errno)) {
      return true;
    }
    return false;
  }
}
