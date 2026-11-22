/**
 * One-off: seed app-config tables with the shared design-system token contract.
 * Run: npx tsx scripts/seed-app-config-now.ts
 */
import { seedAppConfig } from '../prisma/seed/shared/app-config.js';
import { container } from '../src/core/di.js';
import { DatabaseService } from '../src/core/database/index.js';
import { PrismaClientProvider } from '../src/core/database/client/PrismaClientProvider.js';

async function main() {
  const db = container.resolve<DatabaseService>('databaseService');
  const provider = container.resolve<PrismaClientProvider>('provider');
  const prisma = db.client;

  const before = {
    themes: await prisma.appTheme.count(),
    locales: await prisma.appLocale.count(),
    fonts: await prisma.appFont.count(),
    translations: await prisma.appTranslation.count(),
  };
  console.log('before', before);

  await seedAppConfig(prisma);

  const after = {
    themes: await prisma.appTheme.count(),
    locales: await prisma.appLocale.count(),
    fonts: await prisma.appFont.count(),
    translations: await prisma.appTranslation.count(),
  };
  console.log('after', after);

  // Peek one theme shape
  const sample = await prisma.appTheme.findFirst({
    where: { appKey: 'DRIVER', colorScheme: 'LIGHT' },
  });
  const tokens = sample?.tokens as Record<string, unknown> | null;
  console.log('sample token top-level keys:', tokens ? Object.keys(tokens) : null);

  await provider.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
