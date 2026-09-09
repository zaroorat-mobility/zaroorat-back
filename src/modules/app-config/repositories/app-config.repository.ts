import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type {
  AppClient,
  AppColorScheme,
  AppFont,
  AppLocale,
  AppTheme,
  AppTranslation,
  FontSource,
  Prisma,
} from '../../../generated/prisma/index.js';

export interface UpsertThemeInput {
  appKey: AppClient;
  colorScheme: AppColorScheme;
  tokens: Prisma.InputJsonValue;
  components: Prisma.InputJsonValue;
  isActive?: boolean;
  isDefault?: boolean;
}

export interface FontInput {
  family: string;
  weight: string;
  style?: string;
  source?: FontSource;
  url?: string | null;
  isActive?: boolean;
}

export interface UpsertLocaleInput {
  code: string;
  label: string;
  nativeLabel: string;
  isRtl?: boolean;
  isActive?: boolean;
  isDefault?: boolean;
  sortOrder?: number;
}

export interface TranslationEntry {
  key: string;
  value: string;
}

export class AppConfigRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  async findTheme(
    appKey: AppClient,
    colorScheme: AppColorScheme,
    tx?: TransactionClient,
  ): Promise<AppTheme | null> {
    const client = tx ?? this.client;
    return client.appTheme.findUnique({
      where: { appKey_colorScheme: { appKey, colorScheme } },
    });
  }

  async findThemesByApp(appKey: AppClient, tx?: TransactionClient): Promise<AppTheme[]> {
    const client = tx ?? this.client;
    return client.appTheme.findMany({
      where: { appKey },
      orderBy: { colorScheme: 'asc' },
    });
  }

  async upsertTheme(input: UpsertThemeInput, tx?: TransactionClient): Promise<AppTheme> {
    const client = tx ?? this.client;
    return client.appTheme.upsert({
      where: {
        appKey_colorScheme: { appKey: input.appKey, colorScheme: input.colorScheme },
      },
      create: {
        appKey: input.appKey,
        colorScheme: input.colorScheme,
        tokens: input.tokens,
        components: input.components,
        isActive: input.isActive ?? true,
        isDefault: input.isDefault ?? true,
      },
      update: {
        tokens: input.tokens,
        components: input.components,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        version: { increment: 1 },
      },
    });
  }

  async findFontsByApp(appKey: AppClient, tx?: TransactionClient): Promise<AppFont[]> {
    const client = tx ?? this.client;
    return client.appFont.findMany({
      where: { appKey, isActive: true },
      orderBy: [{ family: 'asc' }, { weight: 'asc' }],
    });
  }

  async replaceFonts(
    appKey: AppClient,
    fonts: FontInput[],
    tx?: TransactionClient,
  ): Promise<AppFont[]> {
    const client = tx ?? this.client;
    await client.appFont.deleteMany({ where: { appKey } });
    if (fonts.length === 0) return [];
    await client.appFont.createMany({
      data: fonts.map((f) => ({
        appKey,
        family: f.family,
        weight: f.weight,
        style: f.style ?? 'normal',
        source: f.source ?? 'BUNDLED',
        url: f.url ?? null,
        isActive: f.isActive ?? true,
      })),
    });
    return this.findFontsByApp(appKey, tx);
  }

  async findLocales(tx?: TransactionClient): Promise<AppLocale[]> {
    const client = tx ?? this.client;
    return client.appLocale.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async upsertLocale(input: UpsertLocaleInput, tx?: TransactionClient): Promise<AppLocale> {
    const client = tx ?? this.client;
    return client.appLocale.upsert({
      where: { code: input.code },
      create: {
        code: input.code,
        label: input.label,
        nativeLabel: input.nativeLabel,
        isRtl: input.isRtl ?? false,
        isActive: input.isActive ?? true,
        isDefault: input.isDefault ?? false,
        sortOrder: input.sortOrder ?? 0,
      },
      update: {
        label: input.label,
        nativeLabel: input.nativeLabel,
        ...(input.isRtl !== undefined ? { isRtl: input.isRtl } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
  }

  async findTranslations(
    localeCode: string,
    appKey: AppClient,
    tx?: TransactionClient,
  ): Promise<AppTranslation[]> {
    const client = tx ?? this.client;
    return client.appTranslation.findMany({
      where: { localeCode, appKey },
      orderBy: { key: 'asc' },
    });
  }

  async upsertTranslations(
    localeCode: string,
    appKey: AppClient,
    entries: TranslationEntry[],
    tx?: TransactionClient,
  ): Promise<AppTranslation[]> {
    const client = tx ?? this.client;
    for (const entry of entries) {
      await client.appTranslation.upsert({
        where: {
          localeCode_appKey_key: { localeCode, appKey, key: entry.key },
        },
        create: {
          localeCode,
          appKey,
          key: entry.key,
          value: entry.value,
        },
        update: { value: entry.value },
      });
    }
    return this.findTranslations(localeCode, appKey, tx);
  }

  async deleteTranslationsNotIn(
    localeCode: string,
    appKey: AppClient,
    keys: string[],
    tx?: TransactionClient,
  ): Promise<number> {
    const client = tx ?? this.client;
    const result = await client.appTranslation.deleteMany({
      where: {
        localeCode,
        appKey,
        key: { notIn: keys },
      },
    });
    return result.count;
  }
}
