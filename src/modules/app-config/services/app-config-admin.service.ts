import type { Prisma } from '../../../generated/prisma/index.js';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager.js';
import {
  lockForAuditKey,
  recordAdminAction,
  type AdminAuditEntry,
  type AuditActor,
} from '@modules/admin/audit/index.js';
import { AppConfigRepository } from '../repositories/app-config.repository.js';
import { AppConfigCache } from '../cache/app-config.cache.js';
import { AppConfigService, toAppClient, toColorScheme } from './app-config.service.js';
import type { AppClientSlug, ColorSchemeSlug } from '../constants/app-config.constants.js';
import type {
  UpdateFontsBody,
  UpdateLocaleBody,
  UpdateThemeBody,
  UpsertTranslationsBody,
} from '../schemas/app-config.schemas.js';

type AuditPart = Pick<AdminAuditEntry, 'entityType' | 'entityId' | 'summary' | 'before'> & {
  action?: 'CREATE' | 'UPDATE';
  after?: Record<string, unknown>;
};

/// Top-level keys whose value differs between two JSON objects — what a theme edit
/// changed, without copying the (large, cosmetic) token payload into the audit row.
function changedKeys(before: unknown, after: unknown): string[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

const fontSummary = (fonts: Array<{ family: string; weight: number | string; style: string }>) =>
  fonts.map((f) => `${f.family} ${f.weight} ${f.style}`).sort();

export class AppConfigAdminService {
  constructor(
    private readonly appConfigRepository: AppConfigRepository,
    private readonly appConfigCache: AppConfigCache,
    private readonly appConfigService: AppConfigService,
    private readonly transactionManager: TransactionManager,
  ) {}

  async listThemes(app?: AppClientSlug) {
    if (app) {
      return this.appConfigRepository.findThemesByApp(toAppClient(app));
    }
    const [driver, rider, admin] = await Promise.all([
      this.appConfigRepository.findThemesByApp('DRIVER'),
      this.appConfigRepository.findThemesByApp('RIDER'),
      this.appConfigRepository.findThemesByApp('ADMIN'),
    ]);
    return [...driver, ...rider, ...admin];
  }

  async updateTheme(body: UpdateThemeBody, actor: AuditActor) {
    const { value } = await this.change(actor, async (tx) => {
      const appKey = toAppClient(body.app);
      const colorScheme = toColorScheme(body.colorScheme);
      const existing = await this.appConfigRepository.findTheme(appKey, colorScheme, tx);
      const tokens = (body.tokens ?? existing?.tokens ?? {}) as Prisma.InputJsonValue;
      const components = (body.components ?? existing?.components ?? {}) as Prisma.InputJsonValue;
      const theme = await this.appConfigRepository.upsertTheme(
        { appKey, colorScheme, tokens, components },
        tx,
      );
      return {
        value: theme,
        audit: {
          action: existing ? 'UPDATE' : 'CREATE',
          entityType: 'app_theme',
          entityId: theme.id,
          summary: `Theme ${body.app}/${body.colorScheme} updated`,
          after: {
            changedTokens: changedKeys(existing?.tokens, theme.tokens),
            changedComponents: changedKeys(existing?.components, theme.components),
          },
        },
      };
    });
    return value;
  }

  async listFonts(app: AppClientSlug) {
    return this.appConfigRepository.findFontsByApp(toAppClient(app));
  }

  async updateFonts(body: UpdateFontsBody, actor: AuditActor) {
    const { value } = await this.change(actor, async (tx) => {
      const appKey = toAppClient(body.app);
      const before = await this.appConfigRepository.findFontsByApp(appKey, tx);
      const fonts = await this.appConfigRepository.replaceFonts(
        appKey,
        body.fonts.map((f) => ({
          family: f.family,
          weight: f.weight,
          ...(f.style !== undefined ? { style: f.style } : {}),
          ...(f.source !== undefined ? { source: f.source } : {}),
          ...(f.url !== undefined ? { url: f.url } : {}),
          ...(f.isActive !== undefined ? { isActive: f.isActive } : {}),
        })),
        tx,
      );
      return {
        value: fonts,
        audit: {
          entityType: 'app_fonts',
          summary: `Fonts for ${body.app} replaced`,
          before: { app: body.app, fonts: fontSummary(before) },
          after: { app: body.app, fonts: fontSummary(fonts) },
        },
      };
    });
    return value;
  }

  async listLocales() {
    return this.appConfigRepository.findLocales();
  }

  async updateLocale(body: UpdateLocaleBody, actor: AuditActor) {
    const { value } = await this.change(actor, async (tx) => {
      const before = await tx.appLocale.findUnique({ where: { code: body.code } });
      const locale = await this.appConfigRepository.upsertLocale(
        {
          code: body.code,
          label: body.label,
          nativeLabel: body.nativeLabel,
          ...(body.isRtl !== undefined ? { isRtl: body.isRtl } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        },
        tx,
      );
      const state = (l: typeof locale) => ({
        code: l.code,
        label: l.label,
        nativeLabel: l.nativeLabel,
        isRtl: l.isRtl,
        isActive: l.isActive,
        isDefault: l.isDefault,
        sortOrder: l.sortOrder,
      });
      return {
        value: locale,
        audit: {
          action: before ? 'UPDATE' : 'CREATE',
          entityType: 'app_locale',
          entityId: locale.id,
          summary: `Locale ${locale.code} ${before ? 'updated' : 'created'}`,
          ...(before ? { before: state(before) } : {}),
          after: state(locale),
        },
      };
    });
    return value;
  }

  async createLocale(body: UpdateLocaleBody, actor: AuditActor) {
    return this.updateLocale(body, actor);
  }

  async listTranslations(app: AppClientSlug, locale: string) {
    return this.appConfigRepository.findTranslations(locale, toAppClient(app));
  }

  /// The audit row names which keys were added or changed — never their text, which is
  /// large and is the content itself rather than a record of the change.
  async upsertTranslations(body: UpsertTranslationsBody, actor: AuditActor) {
    const { value } = await this.change(actor, async (tx) => {
      const appKey = toAppClient(body.app);
      const before = new Map(
        (await this.appConfigRepository.findTranslations(body.locale, appKey, tx)).map((row) => [
          row.key,
          row.value,
        ]),
      );
      const rows = await this.appConfigRepository.upsertTranslations(
        body.locale,
        appKey,
        body.entries,
        tx,
      );
      const added = body.entries.filter((e) => !before.has(e.key)).map((e) => e.key);
      const changed = body.entries
        .filter((e) => before.has(e.key) && before.get(e.key) !== e.value)
        .map((e) => e.key);
      return {
        value: rows,
        audit: {
          entityType: 'app_translations',
          summary: `Translations ${body.locale}/${body.app}: ${added.length} added, ${changed.length} changed`,
          after: {
            locale: body.locale,
            app: body.app,
            addedCount: added.length,
            changedCount: changed.length,
            keys: [...added, ...changed].sort().slice(0, 100),
          },
        },
      };
    });
    return value;
  }

  async publish(actor: AuditActor) {
    const { version } = await this.change(actor, async () => ({
      value: undefined,
      audit: { entityType: 'app_config', summary: 'App config published' },
    }));
    return { version };
  }

  async resetToDefaults(
    app: AppClientSlug,
    scheme: ColorSchemeSlug,
    defaultTokens: Prisma.InputJsonValue,
    defaultComponents: Prisma.InputJsonValue,
    actor: AuditActor,
  ) {
    const { value } = await this.change(actor, async (tx) => {
      const existing = await this.appConfigRepository.findTheme(
        toAppClient(app),
        toColorScheme(scheme),
        tx,
      );
      const theme = await this.appConfigService.resetAppTheme(
        app,
        scheme,
        defaultTokens,
        defaultComponents,
        tx,
      );
      return {
        value: theme,
        audit: {
          entityType: 'app_theme',
          entityId: theme.id,
          summary: `Theme ${app}/${scheme} reset to defaults`,
          after: {
            changedTokens: changedKeys(existing?.tokens, theme.tokens),
            changedComponents: changedKeys(existing?.components, theme.components),
          },
        },
      };
    });
    return value;
  }

  /// Every app-config write: the change, the public bundle's version bump and one audit
  /// row commit together — a failed audit write leaves the config and its version as they
  /// were. Writers queue on one lock, so the version each row records is the one it set.
  /// The cache is purged after commit: purging for a change that rolled back would only
  /// cost a refetch, but purging before commit could re-cache the old bundle.
  private async change<T>(
    actor: AuditActor,
    apply: (tx: TransactionClient) => Promise<{ value: T; audit: AuditPart }>,
  ): Promise<{ value: T; version: number }> {
    const { value, version } = await this.transactionManager.execute(async (tx) => {
      await lockForAuditKey(tx, 'app_config');
      const previous = await this.appConfigService.getVersion(tx);
      const { value, audit } = await apply(tx);
      const version = await this.appConfigService.bumpVersion(actor.actorId, tx);
      const { action, after, ...rest } = audit;
      await recordAdminAction(tx, {
        ...actor,
        ...rest,
        action: action ?? 'UPDATE',
        after: { ...(after ?? {}), version },
        ...(audit.before === undefined ? { before: { version: previous } } : {}),
        result: 'SUCCESS',
      });
      return { value, version };
    });
    await this.appConfigCache.purgeAll();
    return { value, version };
  }
}
