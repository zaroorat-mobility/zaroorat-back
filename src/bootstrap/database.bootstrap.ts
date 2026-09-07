import { container } from '../core/di.js';
import { PrismaClientProvider } from '@core/database/client/PrismaClientProvider.js';
import { RetryService } from '@core/database/retry/RetryService.js';
import { registerReadinessCheck } from '@core/health/index.js';
export async function bootstrapDatabase(): Promise<void> {
  const provider = container.resolve<PrismaClientProvider>('provider');
  const retry = container.resolve<RetryService>('retryService');
  // Boot must outlast a database that is merely slow to arrive: a container
  // still starting, a failover, a long checkpoint. Three tries ~100ms apart
  // crash-looped the app against blips it should have ridden out. Ten tries
  // with capped exponential backoff is roughly a 30s budget.
  await retry.executeWithRetry(
    async () => {
      await provider.verifyConnection();
    },
    Number(process.env.DB_BOOT_RETRIES ?? 10),
    Number(process.env.DB_BOOT_RETRY_DELAY_MS ?? 250),
  );
  registerReadinessCheck({
    name: 'database',
    probe: async () => {
      const status = await provider.health();
      if (!status.healthy) {
        throw new Error('database is not reachable');
      }
    },
  });
}
