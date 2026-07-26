// The client comes from src/core/database rather than being constructed here:
// Prisma 7 requires a driver adapter, and that wiring should live in one place.
// Importing '@prisma/client' resolves to the stub package, not the client
// generated into src/generated/prisma, so every model would be missing.
import { container } from '../../src/core/di';
import { DatabaseService } from '../../src/core/database';
import { PrismaClientProvider } from '../../src/core/database/client/PrismaClientProvider';

const provider = container.resolve<PrismaClientProvider>('provider');
const dbService = container.resolve<DatabaseService>('databaseService');
const prisma = dbService.client;
import { seedDevelopment } from './development';
import { seedTesting } from './testing';
import { seedProduction } from './production';

async function main() {
  const env = process.env.APP_ENV || process.env.NODE_ENV || 'development';
  console.log(`\n🌱 Starting Prisma Database Seed [Environment: ${env}]`);

  switch (env) {
    case 'development':
      await seedDevelopment(prisma);
      break;
    case 'test':
    case 'testing':
      await seedTesting(prisma);
      break;
    case 'production':
      await seedProduction(prisma);
      break;
    default:
      console.warn(
        `⚠️  No specific seeder found for environment: ${env}. Defaulting to production seed...`,
      );
      await seedProduction(prisma);
  }

  console.log('✅ Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await provider.disconnect();
  });
