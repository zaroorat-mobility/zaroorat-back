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
}
