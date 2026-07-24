import { PrismaClient } from '@prisma/client';
import { seedDevelopment } from './development';
import { seedTesting } from './testing';
import { seedProduction } from './production';

const prisma = new PrismaClient();

async function main() {
  const env = process.env.APP_ENV || process.env.NODE_ENV || 'development';
  console.log(`\n🌱 Starting Prisma Database Seed [Environment: ${env}]`);

  switch (env) {
    case 'local':
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
    await prisma.$disconnect();
  });
