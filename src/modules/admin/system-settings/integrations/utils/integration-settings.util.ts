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
  /// The page's version: `maxSettingVersion` of the category when the admin
  /// loaded it. Compared with the category's current max, never with one key's
  /// own version: keys saved on every Save advance while a secret that is only
  /// saved when retyped stays behind, so a per-key check refused every later
  /// secret change.
  expectedVersion?: number,
): Promise<void> {
  await deps.txManager.execute(async (tx) => {
    // One save per category at a time, so two admins cannot both pass the check.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`system_settings:${category}`}, 0))`;
    const current = maxSettingVersion(
      await deps.systemSettingService.getCategorySettings(category, tx),
    );
    if (expectedVersion !== undefined && current !== expectedVersion) {
      throw new Error(
        `These settings were changed by someone else (version ${current}, your page has ${expectedVersion}). Refresh and try again.`,
      );
    }
    // Every save moves the page version past every key, even one that only
    // adds a key or changes a key that is behind; the next stale page is then
    // refused. The row holds no value.
    const revisionKey = `${category}.revision`;
    await tx.systemSetting.upsert({
      where: { key: revisionKey },
      create: {
        key: revisionKey,
        value: null,
        category,
        description: 'Internal: save counter for this settings page',
        version: current + 1,
        updatedBy: actorId ?? null,
      },
      update: { version: current + 1, updatedBy: actorId ?? null },
    });

    const changes: Record<string, string | null> = {};

    for (const entry of entries) {
      if (entry.value === undefined) continue;

      await deps.systemSettingService.setSetting(
        {
          key: entry.key,
          value: entry.value,
          category,
          isSecret: entry.isSecret ?? false,
          ...(actorId ? { updatedBy: actorId } : {}),
        },
        tx,
      );

      changes[entry.key] = entry.isSecret ? '[REDACTED]' : entry.value;
    }

    // No actor-presence condition: `recordAdminAction` refuses a missing actor, so a lost
    // actor rolls the change back instead of committing it unaudited.
    if (Object.keys(changes).length > 0) {
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
