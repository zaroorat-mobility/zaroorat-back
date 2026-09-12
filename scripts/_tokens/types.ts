/**
 * Platform-agnostic design-system contract.
 * Byte-identical across admin panel, driver app, and rider app.
 * No react-native / DOM imports.
 */

export type AppClient = 'driver' | 'rider' | 'admin';
export type AppColorScheme = 'light' | 'dark';
export type FontSource = 'bundled' | 'google' | 'remote';
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success';

export interface BrandColors {
  primary: string;
  primaryHover: string;
  primaryActive: string;
  onPrimary: string;
  primaryLight: string;
}

export interface SemanticColors {
  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  danger: string;
  dangerSurface: string;
  info: string;
  infoSurface: string;
}

export interface NeutralColors {
  0: string;
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
}

export interface SurfaceColors {
  background: string;
  card: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
  popover: string;
  popoverForeground: string;
  foreground: string;
}

export interface SidebarColors {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  ring: string;
}

export interface ChartColors {
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
}

export interface ThemeColors {
  brand: BrandColors;
  semantic: SemanticColors;
  neutral: NeutralColors;
  surface: SurfaceColors;
  sidebar: SidebarColors;
  chart: ChartColors;
}

export interface TypographyTokens {
  fontFamily: {
    sans: string;
    display: string;
    mono: string;
  };
  size: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    '2xl': number;
    '3xl': number;
  };
  weight: {
    regular: string;
    medium: string;
    semibold: string;
    bold: string;
  };
  lineHeight: {
    tight: number;
    normal: number;
    relaxed: number;
  };
}

export interface SpacingTokens {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  '2xl': number;
  '3xl': number;
}

export interface RadiiTokens {
  sm: number;
  md: number;
  lg: number;
  xl: number;
  full: number;
}

export interface ShadowTokens {
  soft: string;
  card: string;
}

export interface SizeTokens {
  controlHeight: number;
  tabBarHeight: number;
  otpBoxWidth: number;
  otpBoxHeight: number;
}

export interface ThemeTokens {
  colors: ThemeColors;
  typography: TypographyTokens;
  spacing: SpacingTokens;
  radii: RadiiTokens;
  shadows: ShadowTokens;
  sizes: SizeTokens;
}

export interface ButtonVariantSpec {
  background: string;
  backgroundHover?: string;
  backgroundActive?: string;
  backgroundDisabled?: string;
  text: string;
  textDisabled?: string;
  border?: string;
  borderRadius: number;
  height: number;
  fontSize: number;
  fontWeight: string;
}

export interface InputVariantSpec {
  background: string;
  border: string;
  borderFocus: string;
  text: string;
  placeholder: string;
  borderRadius: number;
  height: number;
  fontSize: number;
}

export interface CardVariantSpec {
  background: string;
  border: string;
  borderRadius: number;
  shadow: string;
}

export interface BadgeVariantSpec {
  background: string;
  text: string;
  border?: string;
}

export interface ComponentSpecs {
  button: Record<ButtonVariant, ButtonVariantSpec>;
  input: InputVariantSpec;
  card: CardVariantSpec;
  badge: Record<'primary' | 'success' | 'warning' | 'danger' | 'neutral', BadgeVariantSpec>;
}

export interface AppFontSpec {
  family: string;
  weight: string;
  style: 'normal' | 'italic';
  source: FontSource;
  url?: string | null;
  isActive: boolean;
}

export interface AppLocaleSpec {
  code: string;
  label: string;
  nativeLabel: string;
  isRtl: boolean;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
}

export type TranslationMap = Record<string, string>;

export interface ThemeBundle {
  tokens: ThemeTokens;
  components: ComponentSpecs;
}

export interface AppConfigBundle {
  version: number;
  app: AppClient;
  locale: string;
  theme: {
    light: ThemeBundle;
    dark: ThemeBundle;
  };
  fonts: AppFontSpec[];
  locales: AppLocaleSpec[];
  strings: TranslationMap;
  featureFlags: Record<string, boolean>;
}

export type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K];
};
