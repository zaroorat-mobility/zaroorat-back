import type { DatabaseService } from '@core/database';
import type { FeatureFlagStatus } from '../../../../../generated/prisma/index.js';
import { FEATURE_FLAG_SEED } from '../constants/platform-settings.constants.js';

export class FeatureFlagService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async ensureSeeded(): Promise<void> {
    for (const flag of FEATURE_FLAG_SEED) {
      await this.client.featureFlag.upsert({
        where: { key: flag.key },
        update: { name: flag.name, description: flag.description },
        create: {
          key: flag.key,
          name: flag.name,
          description: flag.description,
          status: 'ON',
          rolloutPercentage: 100,
          isActive: true,
        },
      });
    }
  }

  async isEnabled(key: string): Promise<boolean> {
    await this.ensureSeeded();
    const flag = await this.client.featureFlag.findUnique({ where: { key } });
    if (!flag || !flag.isActive) return false;
    if (flag.status === 'OFF') return false;
    if (flag.status === 'ON') return true;
    return flag.rolloutPercentage > 0;
  }

  async listFlags() {
    await this.ensureSeeded();
    return this.client.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async updateFlag(
    key: string,
    input: { status?: FeatureFlagStatus; rolloutPercentage?: number; isActive?: boolean },
  ) {
    await this.ensureSeeded();
    return this.client.featureFlag.update({
      where: { key },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.rolloutPercentage !== undefined
          ? { rolloutPercentage: input.rolloutPercentage }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  }
}
