import '../tests/integration/helpers/load-test-env.js';
import { container } from '../src/core/di.js';
import type { DatabaseService } from '../src/core/database/DatabaseService.js';
import type { PrismaClientProvider } from '../src/core/database/client/PrismaClientProvider.js';

async function main() {
  const db = container.resolve<DatabaseService>('databaseService');
  await db.client.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "driver_subscriptions_one_pending"
    ON "driver_subscriptions" ("driver_id")
    WHERE "status" = 'PENDING_PAYMENT'
  `);
  console.log('Index driver_subscriptions_one_pending applied successfully.');
  await container.resolve<PrismaClientProvider>('provider').disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
