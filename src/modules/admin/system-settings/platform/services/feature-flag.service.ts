import type { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { FeatureFlagStatus } from '../../../../../generated/prisma/index.js';
import { FEATURE_FLAG_SEED } from '../constants/platform-settings.constants.js';
import { PAYMENT_FEATURE_FLAG_SEED } from '../constants/payment-feature-flags.constants.js';
import { PRICING_FEATURE_FLAG_SEED } from '../constants/pricing-feature-flags.constants.js';

const SEED: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  defaultStatus?: FeatureFlagStatus;
}> = [...FEATURE_FLAG_SEED, ...PAYMENT_FEATURE_FLAG_SEED, ...PRICING_FEATURE_FLAG_SEED];

export class FeatureFlagService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  /// `defaultStatus` applies only when a flag is first created: re-seeding never
  /// changes a status staff have set.
  async ensureSeeded(): Promise<void> {
    for (const flag of SEED) {
      await this.client.featureFlag.upsert({
        where: { key: flag.key },
        update: { name: flag.name, description: flag.description },
        create: {
          key: flag.key,
          name: flag.name,
          description: flag.description,
          status: flag.defaultStatus ?? 'ON',
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

  /// For the quote path, where `isEnabled`'s seeding would write on every call.
  /// A missing row counts as on, so use this only for a flag seeded ON.
  async isOn(key: string): Promise<boolean> {
    const flag = await this.client.featureFlag.findUnique({ where: { key } });
    if (!flag) return true;
    if (!flag.isActive || flag.status === 'OFF') return false;
    return flag.status === 'ON' || flag.rolloutPercentage > 0;
  }

  /// Read-only check for default-OFF flags (never writes/seeds on hot request paths).
  /// A missing row counts as OFF.
  async isEnabledReadOnly(key: string): Promise<boolean> {
    const flag = await this.client.featureFlag.findUnique({ where: { key } });
    if (!flag || !flag.isActive || flag.status === 'OFF') return false;
    return flag.status === 'ON' || flag.rolloutPercentage > 0;
  }

  async listFlags() {
    await this.ensureSeeded();
    return this.client.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  /// Inside the caller's transaction, which owns the row lock and the audit row.
  async updateFlag(
    id: string,
    input: { status?: FeatureFlagStatus; rolloutPercentage?: number; isActive?: boolean },
    tx: TransactionClient,
  ) {
    return tx.featureFlag.update({
      where: { id },
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
