/* eslint-disable @typescript-eslint/no-explicit-any */
import { container } from '../src/core/di.js';
import type { DatabaseService } from '../src/core/database/index.js';

async function main() {
  const dbService = container.resolve<DatabaseService>('db');
  const prisma = dbService.client;
  console.log('Starting migration of VehicleType pricing columns to PricingRule...');

  const vehicleTypes = await prisma.vehicleType.findMany();
  console.log(`Found ${vehicleTypes.length} vehicle types to migrate.`);

  let migrated = 0;
  for (const vt of vehicleTypes) {
    // Only migrate if we haven't already created a global rule for this type
    const existing = await prisma.pricingRule.findFirst({
      where: { vehicleTypeId: vt.id, cityCode: 'GLOBAL' },
    });

    if (existing) {
      console.log(`Skipping ${vt.code}: PricingRule already exists for GLOBAL city.`);
      continue;
    }

    await prisma.pricingRule.create({
      data: {
        vehicleTypeId: vt.id,
        cityCode: 'GLOBAL',
        baseFare: (vt as any).baseFare ?? 50,
        minimumFare: (vt as any).minimumFare ?? 50,
        perKmRate: (vt as any).perKmRate ?? 12,
        perMinuteRate: (vt as any).perMinuteRate ?? 2,
        waitingPerMin: (vt as any).waitingCharge ?? 3,
        // Other defaults from pricing.prisma will apply
        isActive: true,
      },
    });
    migrated++;
    console.log(`Migrated ${vt.code}`);
  }

  console.log(`Migration complete! Successfully migrated ${migrated} vehicle types.`);
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    const dbService = container.resolve<DatabaseService>('db');
    await dbService.client.$disconnect();
    process.exit(0);
  });
