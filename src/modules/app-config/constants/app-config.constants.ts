export const APP_CONFIG_VERSION_KEY = 'app_config.version';
export const APP_CONFIG_CACHE_PREFIX = 'app_config';
export const APP_CONFIG_CACHE_TTL_SECONDS = 3600;

export const APP_CLIENTS = ['driver', 'rider', 'admin'] as const;
export type AppClientSlug = (typeof APP_CLIENTS)[number];

export const COLOR_SCHEMES = ['light', 'dark'] as const;
export type ColorSchemeSlug = (typeof COLOR_SCHEMES)[number];

/** Full ThemeTokens contract — brand #2B317A. Used by seed + reset + public fallback. */
export const DEFAULT_THEME_TOKENS_LIGHT = Object.freeze({
  colors: {
    brand: {
      primary: '#2B317A',
      primaryHover: '#252B6A',
      primaryActive: '#1E2258',
      onPrimary: '#FFFFFF',
      primaryLight: '#8FA5D6',
    },
    semantic: {
      success: '#00A859',
      successSurface: '#E6F6ED',
      warning: '#F2994A',
      warningSurface: '#FFF4E5',
      danger: '#EF4444',
      dangerSurface: '#FEE2E2',
      info: '#1A56DB',
      infoSurface: '#EEF2FF',
    },
    neutral: {
      '0': '#FFFFFF',
      '50': '#F8FAFC',
      '100': '#F1F5F9',
      '200': '#E2E8F0',
      '300': '#CBD5E1',
      '400': '#94A3B8',
      '500': '#64748B',
      '600': '#475569',
      '700': '#334155',
      '800': '#1E293B',
      '900': '#0F172A',
    },
    surface: {
      background: '#F8FAFC',
      card: '#FFFFFF',
      muted: '#F1F5F9',
      mutedForeground: '#64748B',
      accent: '#EFF6FF',
      accentForeground: '#2B317A',
      border: '#E2E8F0',
      input: '#E2E8F0',
      ring: '#2B317A',
      popover: '#FFFFFF',
      popoverForeground: '#0F172A',
      foreground: '#0F172A',
    },
    sidebar: {
      background: '#0F172A',
      foreground: '#94A3B8',
      primary: '#2B317A',
      primaryForeground: '#FFFFFF',
      accent: '#1E293B',
      accentForeground: '#FFFFFF',
      border: 'rgba(255, 255, 255, 0.06)',
      ring: '#2B317A',
    },
    chart: {
      chart1: '#2B317A',
      chart2: '#22C55E',
      chart3: '#F59E0B',
      chart4: '#3B82F6',
      chart5: '#EF4444',
    },
  },
  typography: {
    fontFamily: {
      sans: 'Inter',
      display: 'Inter',
      mono: 'ui-monospace',
    },
    size: {
      xs: 11,
      sm: 12,
      md: 14,
      lg: 16,
      xl: 18,
      '2xl': 22,
      '3xl': 24,
    },
    weight: {
      regular: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    lineHeight: {
      tight: 1.2,
      normal: 1.4,
      relaxed: 1.6,
    },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    '2xl': 24,
    '3xl': 32,
  },
  radii: {
    sm: 6,
    md: 8,
    lg: 12,
    xl: 20,
    full: 9999,
  },
  shadows: {
    soft: '0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px 0 rgba(0, 0, 0, 0.03)',
    card: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
  },
  sizes: {
    controlHeight: 50,
    tabBarHeight: 80,
    otpBoxWidth: 60,
    otpBoxHeight: 70,
  },
});

export const DEFAULT_THEME_TOKENS_DARK = Object.freeze({
  colors: {
    brand: {
      primary: '#4F5FBF',
      primaryHover: '#3F4FA3',
      primaryActive: '#2F3E87',
      onPrimary: '#FFFFFF',
      primaryLight: '#818CF8',
    },
    semantic: {
      success: '#22C55E',
      successSurface: '#052E16',
      warning: '#F59E0B',
      warningSurface: '#422006',
      danger: '#EF4444',
      dangerSurface: '#450A0A',
      info: '#818CF8',
      infoSurface: '#1E293B',
    },
    neutral: {
      '0': '#020817',
      '50': '#0F172A',
      '100': '#1E293B',
      '200': '#334155',
      '300': '#475569',
      '400': '#64748B',
      '500': '#94A3B8',
      '600': '#CBD5E1',
      '700': '#E2E8F0',
      '800': '#F1F5F9',
      '900': '#F8FAFC',
    },
    surface: {
      background: '#0F172A',
      card: '#1E293B',
      muted: '#1E293B',
      mutedForeground: '#94A3B8',
      accent: '#1E293B',
      accentForeground: '#818CF8',
      border: 'rgba(255, 255, 255, 0.08)',
      input: 'rgba(255, 255, 255, 0.08)',
      ring: '#4F5FBF',
      popover: '#1E293B',
      popoverForeground: '#F8FAFC',
      foreground: '#F8FAFC',
    },
    sidebar: {
      background: '#020817',
      foreground: '#94A3B8',
      primary: '#4F5FBF',
      primaryForeground: '#FFFFFF',
      accent: '#1E293B',
      accentForeground: '#FFFFFF',
      border: 'rgba(255, 255, 255, 0.06)',
      ring: '#4F5FBF',
    },
    chart: {
      chart1: '#4F5FBF',
      chart2: '#4ADE80',
      chart3: '#FBBF24',
      chart4: '#60A5FA',
      chart5: '#F87171',
    },
  },
  typography: {
    fontFamily: {
      sans: 'Inter',
      display: 'Inter',
      mono: 'ui-monospace',
    },
    size: {
      xs: 11,
      sm: 12,
      md: 14,
      lg: 16,
      xl: 18,
      '2xl': 22,
      '3xl': 24,
    },
    weight: {
      regular: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    lineHeight: {
      tight: 1.2,
      normal: 1.4,
      relaxed: 1.6,
    },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    '2xl': 24,
    '3xl': 32,
  },
  radii: {
    sm: 6,
    md: 8,
    lg: 12,
    xl: 20,
    full: 9999,
  },
  shadows: {
    soft: '0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px 0 rgba(0, 0, 0, 0.03)',
    card: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
  },
  sizes: {
    controlHeight: 50,
    tabBarHeight: 80,
    otpBoxWidth: 60,
    otpBoxHeight: 70,
  },
});

export const DEFAULT_THEME_COMPONENTS = Object.freeze({
  button: {
    primary: {
      background: '#2B317A',
      backgroundHover: '#252B6A',
      backgroundActive: '#1E2258',
      backgroundDisabled: '#8FA5D6',
      text: '#FFFFFF',
      textDisabled: '#FFFFFF',
      borderRadius: 8,
      height: 50,
      fontSize: 16,
      fontWeight: '600',
    },
    secondary: {
      background: '#F1F5F9',
      backgroundHover: '#E2E8F0',
      text: '#0F172A',
      border: '#E2E8F0',
      borderRadius: 8,
      height: 50,
      fontSize: 16,
      fontWeight: '600',
    },
    outline: {
      background: '#FFFFFF',
      backgroundHover: '#F1F5F9',
      text: '#0F172A',
      border: '#E2E8F0',
      borderRadius: 8,
      height: 50,
      fontSize: 16,
      fontWeight: '600',
    },
    ghost: {
      background: 'transparent',
      backgroundHover: '#F1F5F9',
      text: '#0F172A',
      borderRadius: 8,
      height: 50,
      fontSize: 16,
      fontWeight: '600',
    },
    danger: {
      background: '#EF4444',
      backgroundHover: '#DC2626',
      text: '#FFFFFF',
      borderRadius: 8,
      height: 50,
      fontSize: 16,
      fontWeight: '600',
    },
    success: {
      background: '#00A859',
      backgroundHover: '#00924E',
      text: '#FFFFFF',
      borderRadius: 8,
      height: 50,
      fontSize: 16,
      fontWeight: '600',
    },
  },
  input: {
    background: '#FFFFFF',
    border: '#E2E8F0',
    borderFocus: '#2B317A',
    text: '#1E293B',
    placeholder: '#94A3B8',
    borderRadius: 8,
    height: 50,
    fontSize: 16,
  },
  card: {
    background: '#FFFFFF',
    border: '#E2E8F0',
    borderRadius: 12,
    shadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
  },
  badge: {
    primary: {
      background: 'rgba(43, 49, 122, 0.1)',
      text: '#2B317A',
    },
    success: {
      background: '#E6F6ED',
      text: '#00A859',
    },
    warning: {
      background: '#FFF4E5',
      text: '#F2994A',
    },
    danger: {
      background: '#FEE2E2',
      text: '#EF4444',
    },
    neutral: {
      background: '#F1F5F9',
      text: '#64748B',
    },
  },
});

export function cacheKey(app: string, locale: string, version: number): string {
  return `${APP_CONFIG_CACHE_PREFIX}:${app}:${locale}:v${version}`;
}
