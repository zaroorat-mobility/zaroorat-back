import '../tests/integration/helpers/load-test-env.js';
import { container } from '../src/core/di.js';
import type { DatabaseService } from '../src/core/database/DatabaseService.js';
import type { PrismaClientProvider } from '../src/core/database/client/PrismaClientProvider.js';

async function check() {
  const db = container.resolve<DatabaseService>('databaseService');
  const dups = await db.client.$queryRaw`
    SELECT "driver_id", COUNT(*) 
    FROM "driver_subscriptions" 
    WHERE "status" = 'PENDING_PAYMENT' 
    GROUP BY "driver_id" 
    HAVING COUNT(*) > 1
  `;
  console.log('Duplicates in database:', JSON.stringify(dups));
  await container.resolve<PrismaClientProvider>('provider').disconnect();
  process.exit(0);
}

check().catch((err) => {
  console.error(err);
  process.exit(1);
});
