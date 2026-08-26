import type { ProviderClient } from '@core/database/index.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import type { PricingRule } from '../../../generated/prisma/index.js';

/// The half-open window a rule is actually in force for: `effectiveFrom <= now
/// < effectiveTo`, with a null `effectiveTo` meaning "still current".
///
/// Neither bound used to be checked. `isActive` was the only filter, so:
///
///   - A rule whose `effectiveTo` had passed still priced rides. Ending a rate
///     card did nothing; the only way to retire one was to flip `isActive`,
///     which makes `effectiveTo` decorative and is not what an operator setting
///     an end date expects.
///
///   - Worse, a rule dated into the *future* was not merely eligible but
///     preferred: `findActiveRule` orders by `effectiveFrom` descending and
///     takes the first row, so scheduling next quarter's higher rates applied
///     them immediately, to every ride, the moment the row was written.
///
/// Half-open rather than inclusive at both ends so a card that ends at the
/// instant its successor begins leaves exactly one rule in force, never two.
function inForce(now: Date): Prisma.PricingRuleWhereInput {
  return {
    isActive: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };
}

export class PricingRuleRepository {
  constructor(private readonly db: { client: ProviderClient }) {}

  async findActiveRule(vehicleTypeId: string, cityCode: string): Promise<PricingRule | null> {
    return this.db.client.pricingRule.findFirst({
      where: { vehicleTypeId, cityCode, ...inForce(new Date()) },
      orderBy: {
        effectiveFrom: 'desc',
      },
    });
  }

  /// Every category's fallback rule in one query, for the catalog endpoint.
  /// One call per type would be an N+1 on the first screen the customer app
  /// loads, and `findManyByIds` already exists on the vehicle side for the same
  /// reason.
  ///
  /// Newest `effectiveFrom` wins, matching `findActiveRule`: the rows arrive
  /// oldest-first so a later one overwrites its predecessor in the map.
  async findGlobalRules(
    vehicleTypeIds: readonly string[],
    cityCode: string,
  ): Promise<Map<string, PricingRule>> {
    if (vehicleTypeIds.length === 0) return new Map();
    const rules = await this.db.client.pricingRule.findMany({
      where: { vehicleTypeId: { in: [...vehicleTypeIds] }, cityCode, ...inForce(new Date()) },
      orderBy: { effectiveFrom: 'asc' },
    });
    return new Map(rules.map((rule) => [rule.vehicleTypeId, rule]));
  }
}
