import type { ProviderClient } from '@core/database/index.js';
import type { PricingRule } from '../../../generated/prisma/index.js';

export class PricingRuleRepository {
  constructor(private readonly db: { client: ProviderClient }) {}

  async findActiveRule(vehicleTypeId: string, cityCode: string): Promise<PricingRule | null> {
    return this.db.client.pricingRule.findFirst({
      where: {
        vehicleTypeId,
        cityCode,
        isActive: true,
      },
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
      where: { vehicleTypeId: { in: [...vehicleTypeIds] }, cityCode, isActive: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    return new Map(rules.map((rule) => [rule.vehicleTypeId, rule]));
  }
}
