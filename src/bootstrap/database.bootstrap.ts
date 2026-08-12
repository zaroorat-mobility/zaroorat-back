import { container } from '../core/di.js';
import { PrismaClientProvider } from '@core/database/client/PrismaClientProvider.js';
import { RetryService } from '@core/database/retry/RetryService.js';
import { registerReadinessCheck } from '@core/health/index.js';

export async function bootstrapDatabase(): Promise<void> {
  const provider = container.resolve<PrismaClientProvider>('provider');
  const retry = container.resolve<RetryService>('retryService');

  await retry.executeWithRetry(async () => {
    await provider.verifyConnection();
  });

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
