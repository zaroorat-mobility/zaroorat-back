import type { ThemeTokens } from './types.js';

const sharedTypography = {
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
} as const;

const sharedSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
} as const;

const sharedRadii = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 20,
  full: 9999,
} as const;

const sharedShadows = {
  soft: '0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px 0 rgba(0, 0, 0, 0.03)',
  card: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
} as const;

const sharedSizes = {
  controlHeight: 50,
  tabBarHeight: 80,
  otpBoxWidth: 60,
  otpBoxHeight: 70,
} as const;

export const lightTokens: ThemeTokens = {
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
      0: '#FFFFFF',
      50: '#F8FAFC',
      100: '#F1F5F9',
      200: '#E2E8F0',
      300: '#CBD5E1',
      400: '#94A3B8',
      500: '#64748B',
      600: '#475569',
      700: '#334155',
      800: '#1E293B',
      900: '#0F172A',
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
  typography: sharedTypography,
  spacing: sharedSpacing,
  radii: sharedRadii,
  shadows: sharedShadows,
  sizes: sharedSizes,
};

export const darkTokens: ThemeTokens = {
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
      0: '#020817',
      50: '#0F172A',
      100: '#1E293B',
      200: '#334155',
      300: '#475569',
      400: '#64748B',
      500: '#94A3B8',
      600: '#CBD5E1',
      700: '#E2E8F0',
      800: '#F1F5F9',
      900: '#F8FAFC',
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
  typography: sharedTypography,
  spacing: sharedSpacing,
  radii: sharedRadii,
  shadows: sharedShadows,
  sizes: sharedSizes,
};

export const defaultTokens = {
  light: lightTokens,
  dark: darkTokens,
} as const;
