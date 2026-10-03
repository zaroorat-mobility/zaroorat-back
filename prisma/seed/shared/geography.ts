import { ProviderClient } from '../../../src/core/database';
import referenceData from '../reference/india-states-lgd.json';

export interface LgdStateRecord {
  lgdCode: number;
  code: string;
  name: string;
  nativeName?: string | null;
  divisionType: 'STATE' | 'UNION_TERRITORY';
  isoCode: string;
  censusCode?: string | null;
}

/**
 * Canonical Geographic Reference Seeder (GoI LGD + ISO 3166-2:IN).
 * Populates Country ('IN') and all 28 States + 8 Union Territories.
 * Preserves existing State UUIDs (including JK, KA, MH) and synchronizes city.state denormalized names.
 */
export async function seedGeographicReference(prisma: ProviderClient): Promise<void> {
  const india = await prisma.country.upsert({
    where: { code: 'IN' },
    update: { name: 'India', isActive: true },
    create: { code: 'IN', name: 'India', isActive: true },
  });

  const records = referenceData.records as LgdStateRecord[];
  if (!records || records.length !== 36) {
    throw new Error(
      `Invalid canonical reference data: expected 36 records, got ${records?.length}`,
    );
  }

  // ONLY seed the initial states that Zaroorat Mobility operates in:
  // All other states remain in the reference catalog for admins to add on-demand.
  const operationalCodes = new Set(['JK', 'KA', 'MH', 'DL', 'TN']);
  const operationalRecords = records.filter((r) => operationalCodes.has(r.code));

  for (const r of operationalRecords) {
    const existing = await prisma.state.findFirst({
      where: {
        countryId: india.id,
        OR: [{ lgdCode: r.lgdCode }, { code: r.code }],
      },
    });

    if (existing) {
      await prisma.state.update({
        where: { id: existing.id },
        data: {
          code: r.code,
          name: r.name,
          nativeName: r.nativeName ?? null,
          divisionType: r.divisionType,
          lgdCode: r.lgdCode,
          isoCode: r.isoCode,
          censusCode: r.censusCode ?? null,
        },
      });

      // Synchronize city legacy denormalized state name
      await prisma.city.updateMany({
        where: { stateId: existing.id },
        data: { state: r.name },
      });
    } else {
      await prisma.state.create({
        data: {
          countryId: india.id,
          code: r.code,
          name: r.name,
          nativeName: r.nativeName ?? null,
          divisionType: r.divisionType,
          lgdCode: r.lgdCode,
          isoCode: r.isoCode,
          censusCode: r.censusCode ?? null,
          isActive: r.code !== 'TN', // TN inactive, JK/KA/MH/DL active
        },
      });
    }
  }

  console.log(`  -> Seeded operational states (${operationalRecords.length} states)`);
}
