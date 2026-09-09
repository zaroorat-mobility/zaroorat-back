import type { AppClient, AppColorScheme, Prisma } from '../../../generated/prisma/index.js';
import { SystemSettingService } from '@modules/admin/system-settings/services/system-setting.service.js';
import { FeatureFlagService } from '@modules/admin/system-settings/platform/services/feature-flag.service.js';
import { logger } from '@shared/logger/index.js';
import { AppConfigRepository } from '../repositories/app-config.repository.js';
import { AppConfigCache } from '../cache/app-config.cache.js';
import {
  APP_CONFIG_CACHE_TTL_SECONDS,
  APP_CONFIG_VERSION_KEY,
  DEFAULT_THEME_COMPONENTS,
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
  type AppClientSlug,
  type ColorSchemeSlug,
} from '../constants/app-config.constants.js';

export interface AppConfigBundle {
  version: number;
  app: AppClientSlug;
  locale: string;
  theme: {
    light: { tokens: unknown; components: unknown };
    dark: { tokens: unknown; components: unknown };
  };
  fonts: Array<{
    family: string;
    weight: string;
    style: string;
    source: string;
    url: string | null;
  }>;
  locales: Array<{
    code: string;
    label: string;
    nativeLabel: string;
    isRtl: boolean;
    isDefault: boolean;
    sortOrder: number;
  }>;
  strings: Record<string, string>;
  featureFlags: Record<string, boolean>;
}

const APP_CLIENT_MAP: Record<AppClientSlug, AppClient> = {
  driver: 'DRIVER',
  rider: 'RIDER',
  admin: 'ADMIN',
};

const COLOR_SCHEME_MAP: Record<ColorSchemeSlug, AppColorScheme> = {
  light: 'LIGHT',
  dark: 'DARK',
};

const EMPTY_THEME = { tokens: {}, components: {} };

export function toAppClient(app: AppClientSlug): AppClient {
  return APP_CLIENT_MAP[app];
}

export function toColorScheme(scheme: ColorSchemeSlug): AppColorScheme {
  return COLOR_SCHEME_MAP[scheme];
}

export class AppConfigService {
  constructor(
    private readonly appConfigRepository: AppConfigRepository,
    private readonly appConfigCache: AppConfigCache,
    private readonly systemSettingService: SystemSettingService,
    private readonly featureFlagService?: FeatureFlagService,
  ) {}

  async getVersion(): Promise<number> {
    const raw = await this.systemSettingService.getSettingValue(APP_CONFIG_VERSION_KEY);
    if (raw === null || raw === undefined || raw === '') return 1;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  async bumpVersion(updatedBy?: string | null): Promise<number> {
    const current = await this.getVersion();
    const next = current + 1;
    await this.systemSettingService.setSetting({
      key: APP_CONFIG_VERSION_KEY,
      value: String(next),
      category: 'app_config',
      description: 'Public app-config bundle version (ETag / cache bust)',
      updatedBy: updatedBy ?? null,
    });
    return next;
  }

  async getPublicBundle(app: AppClientSlug, locale: string): Promise<AppConfigBundle> {
    const version = await this.getVersion();
    const cached = await this.appConfigCache.getBundle<AppConfigBundle>(app, locale, version);
    if (cached) return cached;

    const appKey = toAppClient(app);
    const [light, dark, fonts, locales, translations, featureFlags] = await Promise.all([
      this.appConfigRepository.findTheme(appKey, 'LIGHT'),
      this.appConfigRepository.findTheme(appKey, 'DARK'),
      this.appConfigRepository.findFontsByApp(appKey),
      this.appConfigRepository.findLocales(),
      this.appConfigRepository.findTranslations(locale, appKey),
      this.loadFeatureFlags(),
    ]);

    const strings: Record<string, string> = {};
    for (const row of translations) {
      strings[row.key] = row.value;
    }

    const bundle: AppConfigBundle = {
      version,
      app,
      locale,
      theme: {
        light: light ? { tokens: light.tokens, components: light.components } : { ...EMPTY_THEME },
        dark: dark ? { tokens: dark.tokens, components: dark.components } : { ...EMPTY_THEME },
      },
      fonts: fonts.map((f) => ({
        family: f.family,
        weight: f.weight,
        style: f.style,
        source: f.source,
        url: f.url,
      })),
      locales: locales.map((l) => ({
        code: l.code,
        label: l.label,
        nativeLabel: l.nativeLabel,
        isRtl: l.isRtl,
        isDefault: l.isDefault,
        sortOrder: l.sortOrder,
      })),
      strings,
      featureFlags,
    };

    await this.appConfigCache.setBundle(app, locale, version, bundle, APP_CONFIG_CACHE_TTL_SECONDS);
    return bundle;
  }

  async getLocaleStrings(
    app: AppClientSlug,
    localeCode: string,
  ): Promise<{ locale: string; app: AppClientSlug; strings: Record<string, string> }> {
    const rows = await this.appConfigRepository.findTranslations(localeCode, toAppClient(app));
    const strings: Record<string, string> = {};
    for (const row of rows) {
      strings[row.key] = row.value;
    }
    return { locale: localeCode, app, strings };
  }

  async resetAppTheme(
    app: AppClientSlug,
    scheme: ColorSchemeSlug,
    defaultTokens?: Prisma.InputJsonValue,
    defaultComponents?: Prisma.InputJsonValue,
  ) {
    const tokens =
      defaultTokens ?? (scheme === 'dark' ? DEFAULT_THEME_TOKENS_DARK : DEFAULT_THEME_TOKENS_LIGHT);
    const components = defaultComponents ?? DEFAULT_THEME_COMPONENTS;
    return this.appConfigRepository.upsertTheme({
      appKey: toAppClient(app),
      colorScheme: toColorScheme(scheme),
      tokens: tokens as Prisma.InputJsonValue,
      components: components as Prisma.InputJsonValue,
      isDefault: true,
      isActive: true,
    });
  }

  private async loadFeatureFlags(): Promise<Record<string, boolean>> {
    if (!this.featureFlagService) return {};
    try {
      const flags = await this.featureFlagService.listFlags();
      const map: Record<string, boolean> = {};
      for (const flag of flags) {
        map[flag.key] =
          flag.isActive &&
          flag.status !== 'OFF' &&
          (flag.status === 'ON' || flag.rolloutPercentage > 0);
      }
      return map;
    } catch (err) {
      logger.warn({ err }, '[AppConfigService] Failed to load feature flags');
      return {};
    }
  }
}
