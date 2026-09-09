export const APP_CONFIG_VERSION_KEY = 'app_config.version';
export const APP_CONFIG_CACHE_PREFIX = 'app_config';
export const APP_CONFIG_CACHE_TTL_SECONDS = 3600;

export const APP_CLIENTS = ['driver', 'rider', 'admin'] as const;
export type AppClientSlug = (typeof APP_CLIENTS)[number];

export const COLOR_SCHEMES = ['light', 'dark'] as const;
export type ColorSchemeSlug = (typeof COLOR_SCHEMES)[number];

/** Compact default theme tokens — brand #2B317A. Used by seed + reset. */
export const DEFAULT_THEME_TOKENS_LIGHT = Object.freeze({
  brand: {
    primary: '#2B317A',
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
    ring: '#2B317A',
  },
  typography: {
    fontFamily: { sans: 'Inter', display: 'Inter', mono: 'monospace' },
    size: { xs: 12, sm: 14, md: 16, lg: 18, xl: 20, '2xl': 24 },
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 8, lg: 12, full: 9999 },
});

export const DEFAULT_THEME_TOKENS_DARK = Object.freeze({
  brand: {
    primary: '#6B73C7',
    primaryHover: '#858CD4',
    primaryActive: '#9AA0DC',
    onPrimary: '#FFFFFF',
    primaryLight: '#2B317A',
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
});

export const DEFAULT_THEME_COMPONENTS = Object.freeze({
  button: {
    primary: { background: 'brand.primary', color: 'brand.onPrimary', radius: 'md' },
    secondary: { background: 'surface.muted', color: 'surface.foreground', radius: 'md' },
  },
  input: { background: 'surface.card', border: 'surface.input', radius: 'md' },
  card: { background: 'surface.card', border: 'surface.border', radius: 'lg' },
});

export function cacheKey(app: string, locale: string, version: number): string {
  return `${APP_CONFIG_CACHE_PREFIX}:${app}:${locale}:v${version}`;
}
