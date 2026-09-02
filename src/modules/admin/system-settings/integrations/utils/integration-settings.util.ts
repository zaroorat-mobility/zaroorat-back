import type { TransactionManager } from '@core/database';
import { recordAdminAction } from '../../../audit/index.js';
import type { SystemSettingService } from '../../services/system-setting.service.js';
import type { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import { MASKED_SECRET_VALUE } from '../../map/constants/map-settings.constants.js';

export function isMaskedSecret(value: string | undefined | null): boolean {
  if (!value) return true;
  return value.startsWith('***') || value === MASKED_SECRET_VALUE;
}

export type SettingEntry = {
  key: string;
  value: string | null | undefined;
  isSecret?: boolean | undefined;
  expectedVersion?: number | undefined;
};

export function maxSettingVersion(settings: Map<string, { version: number }>): number {
  let maxVersion = 1;
  for (const item of settings.values()) {
    if (item.version > maxVersion) maxVersion = item.version;
  }
  return maxVersion;
}

export async function saveIntegrationSettings(
  deps: {
    systemSettingService: SystemSettingService;
    systemSettingsCache: SystemSettingsCache;
    txManager: TransactionManager;
  },
  category: string,
  entries: SettingEntry[],
  actorId: string | undefined,
  entityType: string,
  summary: string,
  before?: unknown,
): Promise<void> {
  await deps.txManager.execute(async (tx) => {
    const changes: Record<string, string | null> = {};

    for (const entry of entries) {
      if (entry.value === undefined) continue;

      await deps.systemSettingService.setSetting(
        {
          key: entry.key,
          value: entry.value,
          category,
          isSecret: entry.isSecret ?? false,
          ...(entry.expectedVersion !== undefined
            ? { expectedVersion: entry.expectedVersion }
            : {}),
          ...(actorId ? { updatedBy: actorId } : {}),
        },
        tx,
      );

      changes[entry.key] = entry.isSecret ? '[REDACTED]' : entry.value;
    }

    if (actorId && Object.keys(changes).length > 0) {
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType,
        summary,
        ...(before !== undefined ? { before } : {}),
        after: changes,
      });
    }
  });

  await deps.systemSettingsCache.invalidateCategory(category);
}
