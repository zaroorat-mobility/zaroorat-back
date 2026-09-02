import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { SystemSetting } from '../../../../generated/prisma/index.js';

export interface UpsertSystemSettingInput {
  key: string;
  value: string | null;
  category?: string | undefined;
  description?: string | null | undefined;
  isSecret?: boolean | undefined;
  expectedVersion?: number | undefined;
  updatedBy?: string | null | undefined;
}

export class SystemSettingRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  async findByKey(key: string, tx?: TransactionClient): Promise<SystemSetting | null> {
    const client = tx ?? this.client;
    return client.systemSetting.findUnique({ where: { key } });
  }

  async findByCategory(category: string, tx?: TransactionClient): Promise<SystemSetting[]> {
    const client = tx ?? this.client;
    return client.systemSetting.findMany({
      where: { category },
      orderBy: { key: 'asc' },
    });
  }

  async findManyByKeys(keys: string[], tx?: TransactionClient): Promise<SystemSetting[]> {
    const client = tx ?? this.client;
    return client.systemSetting.findMany({
      where: { key: { in: keys } },
    });
  }

  async upsertSetting(
    input: UpsertSystemSettingInput,
    tx?: TransactionClient,
  ): Promise<SystemSetting> {
    const client = tx ?? this.client;
    const existing = await client.systemSetting.findUnique({ where: { key: input.key } });

    if (existing) {
      if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
        throw new Error(
          `SystemSetting conflict for key '${input.key}': current version ${existing.version}, expected ${input.expectedVersion}`,
        );
      }

      return client.systemSetting.update({
        where: { key: input.key },
        data: {
          value: input.value,
          ...(input.category ? { category: input.category } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isSecret !== undefined ? { isSecret: input.isSecret } : {}),
          ...(input.updatedBy !== undefined ? { updatedBy: input.updatedBy } : {}),
          version: { increment: 1 },
        },
      });
    }

    return client.systemSetting.create({
      data: {
        key: input.key,
        value: input.value,
        category: input.category ?? 'system',
        description: input.description ?? null,
        isSecret: input.isSecret ?? false,
        version: 1,
        updatedBy: input.updatedBy ?? null,
      },
    });
  }
}
