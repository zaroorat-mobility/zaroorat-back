import type { Prisma } from '../../../generated/prisma/index.js';
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

export class AppConfigAdminService {
  constructor(
    private readonly appConfigRepository: AppConfigRepository,
    private readonly appConfigCache: AppConfigCache,
    private readonly appConfigService: AppConfigService,
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

  async updateTheme(body: UpdateThemeBody, updatedBy?: string | null) {
    const existing = await this.appConfigRepository.findTheme(
      toAppClient(body.app),
      toColorScheme(body.colorScheme),
    );
    const tokens = (body.tokens ?? existing?.tokens ?? {}) as Prisma.InputJsonValue;
    const components = (body.components ?? existing?.components ?? {}) as Prisma.InputJsonValue;
    const theme = await this.appConfigRepository.upsertTheme({
      appKey: toAppClient(body.app),
      colorScheme: toColorScheme(body.colorScheme),
      tokens,
      components,
    });
    await this.afterWrite(updatedBy);
    return theme;
  }

  async listFonts(app: AppClientSlug) {
    return this.appConfigRepository.findFontsByApp(toAppClient(app));
  }

  async updateFonts(body: UpdateFontsBody, updatedBy?: string | null) {
    const fonts = await this.appConfigRepository.replaceFonts(
      toAppClient(body.app),
      body.fonts.map((f) => ({
        family: f.family,
        weight: f.weight,
        ...(f.style !== undefined ? { style: f.style } : {}),
        ...(f.source !== undefined ? { source: f.source } : {}),
        ...(f.url !== undefined ? { url: f.url } : {}),
        ...(f.isActive !== undefined ? { isActive: f.isActive } : {}),
      })),
    );
    await this.afterWrite(updatedBy);
    return fonts;
  }

  async listLocales() {
    return this.appConfigRepository.findLocales();
  }

  async updateLocale(body: UpdateLocaleBody, updatedBy?: string | null) {
    const locale = await this.appConfigRepository.upsertLocale({
      code: body.code,
      label: body.label,
      nativeLabel: body.nativeLabel,
      ...(body.isRtl !== undefined ? { isRtl: body.isRtl } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
    });
    await this.afterWrite(updatedBy);
    return locale;
  }

  async createLocale(body: UpdateLocaleBody, updatedBy?: string | null) {
    return this.updateLocale(body, updatedBy);
  }

  async listTranslations(app: AppClientSlug, locale: string) {
    return this.appConfigRepository.findTranslations(locale, toAppClient(app));
  }

  async upsertTranslations(body: UpsertTranslationsBody, updatedBy?: string | null) {
    const rows = await this.appConfigRepository.upsertTranslations(
      body.locale,
      toAppClient(body.app),
      body.entries,
    );
    await this.afterWrite(updatedBy);
    return rows;
  }

  async publish(updatedBy?: string | null) {
    const version = await this.appConfigService.bumpVersion(updatedBy);
    await this.appConfigCache.purgeAll();
    return { version };
  }

  async resetToDefaults(
    app: AppClientSlug,
    scheme: ColorSchemeSlug,
    defaultTokens: Prisma.InputJsonValue,
    defaultComponents: Prisma.InputJsonValue,
    updatedBy?: string | null,
  ) {
    const theme = await this.appConfigService.resetAppTheme(
      app,
      scheme,
      defaultTokens,
      defaultComponents,
    );
    await this.afterWrite(updatedBy);
    return theme;
  }

  private async afterWrite(updatedBy?: string | null): Promise<void> {
    await this.appConfigService.bumpVersion(updatedBy);
    await this.appConfigCache.purgeAll();
  }
}
