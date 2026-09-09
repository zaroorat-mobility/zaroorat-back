import { ProviderClient } from '../../../src/core/database';
import type { AppClient, AppColorScheme, Prisma } from '../../../src/generated/prisma/index.js';

const BRAND = '#2B317A';

const DEFAULT_TOKENS_LIGHT = {
  brand: {
    primary: BRAND,
    primaryHover: '#23285F',
    primaryActive: '#1C214D',
    onPrimary: '#FFFFFF',
    primaryLight: '#E8E9F4',
  },
  semantic: {
    success: '#16A34A',
    successSurface: '#DCFCE7',
    warning: '#D97706',
    warningSurface: '#FEF3C7',
    danger: '#DC2626',
    dangerSurface: '#FEE2E2',
    info: '#2563EB',
    infoSurface: '#DBEAFE',
  },
  surface: {
    background: '#FFFFFF',
    card: '#FFFFFF',
    muted: '#F4F4F5',
    foreground: '#18181B',
    border: '#E4E4E7',
    input: '#E4E4E7',
    ring: BRAND,
  },
  typography: {
    fontFamily: { sans: 'Inter', display: 'Inter', mono: 'monospace' },
    size: { xs: 12, sm: 14, md: 16, lg: 18, xl: 20, '2xl': 24 },
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 8, lg: 12, full: 9999 },
} as const;

const DEFAULT_TOKENS_DARK = {
  brand: {
    primary: '#6B73C7',
    primaryHover: '#858CD4',
    primaryActive: '#9AA0DC',
    onPrimary: '#FFFFFF',
    primaryLight: BRAND,
  },
  semantic: {
    success: '#22C55E',
    successSurface: '#14532D',
    warning: '#F59E0B',
    warningSurface: '#78350F',
    danger: '#EF4444',
    dangerSurface: '#7F1D1D',
    info: '#3B82F6',
    infoSurface: '#1E3A8A',
  },
  surface: {
    background: '#09090B',
    card: '#18181B',
    muted: '#27272A',
    foreground: '#FAFAFA',
    border: '#3F3F46',
    input: '#3F3F46',
    ring: '#6B73C7',
  },
  typography: {
    fontFamily: { sans: 'Inter', display: 'Inter', mono: 'monospace' },
    size: { xs: 12, sm: 14, md: 16, lg: 18, xl: 20, '2xl': 24 },
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 8, lg: 12, full: 9999 },
} as const;

const DEFAULT_COMPONENTS = {
  button: {
    primary: { background: 'brand.primary', color: 'brand.onPrimary', radius: 'md' },
    secondary: { background: 'surface.muted', color: 'surface.foreground', radius: 'md' },
  },
  input: { background: 'surface.card', border: 'surface.input', radius: 'md' },
  card: { background: 'surface.card', border: 'surface.border', radius: 'lg' },
} as const;

const APPS: AppClient[] = ['DRIVER', 'RIDER', 'ADMIN'];
const SCHEMES: AppColorScheme[] = ['LIGHT', 'DARK'];

const INTER_WEIGHTS = ['400', '500', '600', '700'] as const;

const DRIVER_EN_STRINGS: Array<{ key: string; value: string }> = [
  { key: 'common.appName', value: 'Zaroorat Driver' },
  { key: 'common.continue', value: 'Continue' },
  { key: 'auth.loginTitle', value: 'Sign in to drive' },
  { key: 'auth.otpHint', value: 'Enter the code sent to your phone' },
  { key: 'home.goOnline', value: 'Go online' },
  { key: 'home.goOffline', value: 'Go offline' },
];

/**
 * Seeds app themes, fonts, locales, and a small translation set.
 * Safe to re-run (upserts). Reference data for every environment.
 */
export async function seedAppConfig(prisma: ProviderClient): Promise<void> {
  for (const locale of [
    {
      code: 'en',
      label: 'English',
      nativeLabel: 'English',
      isRtl: false,
      isDefault: true,
      sortOrder: 0,
    },
    {
      code: 'hi',
      label: 'Hindi',
      nativeLabel: 'हिन्दी',
      isRtl: false,
      isDefault: false,
      sortOrder: 1,
    },
    {
      code: 'ur',
      label: 'Urdu',
      nativeLabel: 'اردو',
      isRtl: true,
      isDefault: false,
      sortOrder: 2,
    },
  ]) {
    await prisma.appLocale.upsert({
      where: { code: locale.code },
      create: locale,
      update: {
        label: locale.label,
        nativeLabel: locale.nativeLabel,
        isRtl: locale.isRtl,
        isDefault: locale.isDefault,
        sortOrder: locale.sortOrder,
        isActive: true,
      },
    });
  }

  for (const appKey of APPS) {
    for (const colorScheme of SCHEMES) {
      const tokens = colorScheme === 'LIGHT' ? DEFAULT_TOKENS_LIGHT : DEFAULT_TOKENS_DARK;
      await prisma.appTheme.upsert({
        where: { appKey_colorScheme: { appKey, colorScheme } },
        create: {
          appKey,
          colorScheme,
          tokens: tokens as unknown as Prisma.InputJsonValue,
          components: DEFAULT_COMPONENTS as unknown as Prisma.InputJsonValue,
          isActive: true,
          isDefault: true,
        },
        update: {
          tokens: tokens as unknown as Prisma.InputJsonValue,
          components: DEFAULT_COMPONENTS as unknown as Prisma.InputJsonValue,
          isActive: true,
          isDefault: true,
        },
      });
    }
  }

  for (const appKey of ['DRIVER', 'ADMIN'] as AppClient[]) {
    await prisma.appFont.deleteMany({ where: { appKey } });
    await prisma.appFont.createMany({
      data: INTER_WEIGHTS.map((weight) => ({
        appKey,
        family: 'Inter',
        weight,
        style: 'normal',
        source: 'BUNDLED' as const,
        isActive: true,
      })),
    });
  }

  for (const entry of DRIVER_EN_STRINGS) {
    await prisma.appTranslation.upsert({
      where: {
        localeCode_appKey_key: {
          localeCode: 'en',
          appKey: 'DRIVER',
          key: entry.key,
        },
      },
      create: {
        localeCode: 'en',
        appKey: 'DRIVER',
        key: entry.key,
        value: entry.value,
      },
      update: { value: entry.value },
    });
  }

  await prisma.systemSetting.upsert({
    where: { key: 'app_config.version' },
    create: {
      key: 'app_config.version',
      value: '1',
      category: 'app_config',
      description: 'Public app-config bundle version (ETag / cache bust)',
      version: 1,
    },
    update: {},
  });
}
