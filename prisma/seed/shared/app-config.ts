import { ProviderClient } from '../../../src/core/database';
import type { AppClient, AppColorScheme, Prisma } from '../../../src/generated/prisma/index.js';

/** Shared design-system token contract (matches driver/admin ThemeTokens). Brand #2B317A. */
const DEFAULT_TOKENS_LIGHT = {
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
} as const;

const DEFAULT_TOKENS_DARK = {
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
} as const;

const DEFAULT_COMPONENTS = {
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
} as const;

const APPS: AppClient[] = ['DRIVER', 'RIDER', 'ADMIN'];
const SCHEMES: AppColorScheme[] = ['LIGHT', 'DARK'];

const INTER_WEIGHTS = ['400', '500', '600', '700'] as const;

const DRIVER_EN_STRINGS: Array<{ key: string; value: string }> = [
  {
    key: 'auth.login.title',
    value: 'Login to get started',
  },
  {
    key: 'auth.login.countryCode',
    value: '+91',
  },
  {
    key: 'auth.login.mobilePlaceholder',
    value: 'Enter mobile number',
  },
  {
    key: 'auth.login.info',
    value:
      "We'll text you a one-time code. Your number stays private — riders never see it directly, calls are always routed through masked numbers.",
  },
  {
    key: 'auth.login.continue',
    value: 'Continue',
  },
  {
    key: 'auth.login.or',
    value: 'or',
  },
  {
    key: 'auth.login.google',
    value: 'Continue with Google',
  },
  {
    key: 'auth.login.language',
    value: 'Language: {language}',
  },
  {
    key: 'auth.login.termsPrefix',
    value: 'By continuing you agree to our',
  },
  {
    key: 'auth.login.terms',
    value: 'Terms & Conditions',
  },
  {
    key: 'auth.login.and',
    value: 'and',
  },
  {
    key: 'auth.login.privacy',
    value: 'Privacy Policy',
  },
  {
    key: 'auth.header.partner',
    value: 'PARTNER',
  },
  {
    key: 'auth.header.tagline',
    value: 'DRIVE • EARN • BELONG',
  },
  {
    key: 'auth.otp.title',
    value: 'OTP Verification',
  },
  {
    key: 'auth.otp.sentTo',
    value: 'Sent to +91 {mobile}',
  },
  {
    key: 'auth.otp.edit',
    value: 'Edit',
  },
  {
    key: 'auth.otp.verify',
    value: 'Verify',
  },
  {
    key: 'auth.otp.didntReceive',
    value: "Didn't receive code?",
  },
  {
    key: 'auth.otp.resend',
    value: 'Resend',
  },
  {
    key: 'auth.otp.resendIn',
    value: 'in {timer}',
  },
  {
    key: 'permissions.notification.skip',
    value: 'Skip',
  },
  {
    key: 'permissions.notification.title',
    value: 'Stay Updated',
  },
  {
    key: 'permissions.notification.body',
    value:
      'Enable notifications to get real-time updates about your rides, drivers, and safety alerts.',
  },
  {
    key: 'permissions.notification.enable',
    value: 'Enable Notifications',
  },
  {
    key: 'permissions.notification.later',
    value: 'Maybe Later',
  },
  {
    key: 'docs.upload.title',
    value: 'Upload Your Documents',
  },
  {
    key: 'docs.upload.subtitle',
    value:
      'Add a clear photo of each document. Our team verifies most within a few hours so you can start earning.',
  },
  {
    key: 'docs.upload.required',
    value: 'Required Documents',
  },
  {
    key: 'docs.upload.drivingLicence',
    value: 'Driving Licence',
  },
  {
    key: 'docs.upload.rc',
    value: 'Vehicle Registration (RC)',
  },
  {
    key: 'docs.upload.insurance',
    value: 'Insurance Certificate',
  },
  {
    key: 'docs.upload.puc',
    value: 'PUC Certificate',
  },
  {
    key: 'docs.upload.permit',
    value: 'Permit (Taxi / Transport)',
  },
  {
    key: 'docs.upload.fitness',
    value: 'Fitness Certificate',
  },
  {
    key: 'docs.upload.aadhaar',
    value: 'Aadhaar Card',
  },
  {
    key: 'docs.upload.pan',
    value: 'PAN Card',
  },
  {
    key: 'docs.status.uploaded',
    value: 'Uploaded',
  },
  {
    key: 'docs.status.verified',
    value: 'Verified',
  },
  {
    key: 'docs.status.pending',
    value: 'Pending',
  },
  {
    key: 'docs.status.expired',
    value: 'Expired',
  },
  {
    key: 'docs.list.mandatory',
    value: 'Mandatory',
  },
  {
    key: 'docs.list.upload',
    value: 'Upload',
  },
  {
    key: 'docs.bottom.complete',
    value: 'Complete verification to go online',
  },
  {
    key: 'docs.bottom.hint',
    value: 'Once all documents are verified, you can start receiving ride requests',
  },
  {
    key: 'docs.bottom.continue',
    value: 'Continue',
  },
  {
    key: 'docs.detail.save',
    value: 'Save & Continue',
  },
  {
    key: 'docs.detail.fileUploaded',
    value: 'File uploaded',
  },
  {
    key: 'docs.detail.replace',
    value: 'Tap here to replace',
  },
  {
    key: 'docs.success.title',
    value: 'Documents Uploaded',
  },
  {
    key: 'docs.success.great',
    value: 'Great! Your documents have been submitted.',
  },
  {
    key: 'docs.success.body',
    value:
      "We've received all your documents and our team will review them. You'll be notified once verified.",
  },
  {
    key: 'docs.success.process',
    value: 'Verification Process',
  },
  {
    key: 'docs.success.explore',
    value: 'Explore the App',
  },
  {
    key: 'tabs.home',
    value: 'Home',
  },
  {
    key: 'tabs.earnings',
    value: 'Earnings',
  },
  {
    key: 'tabs.security',
    value: 'Security',
  },
  {
    key: 'tabs.activity',
    value: 'Activity',
  },
  {
    key: 'tabs.account',
    value: 'Account',
  },
  {
    key: 'security.placeholder',
    value: 'Emergency SOS and safety tools will appear here. Stay safe on every trip.',
  },
  {
    key: 'home.online',
    value: 'You are Online',
  },
  {
    key: 'home.offline',
    value: 'You are Offline',
  },
  {
    key: 'home.ready',
    value: 'Ready to receive ride requests',
  },
  {
    key: 'home.tapOnline',
    value: 'Tap to go online and start receiving ride requests',
  },
  {
    key: 'home.autoAccept',
    value: 'Auto Accept',
  },
  {
    key: 'home.on',
    value: 'On',
  },
  {
    key: 'home.dutyHours',
    value: 'Duty Hours',
  },
  {
    key: 'home.demand',
    value: 'Demand in your area',
  },
  {
    key: 'home.low',
    value: 'Low',
  },
  {
    key: 'home.highDemand',
    value: 'High Demand',
  },
  {
    key: 'home.nextPickup',
    value: 'Next Schedule Pickup',
  },
  {
    key: 'home.estFare',
    value: 'Est. Fare',
  },
  {
    key: 'home.offlineHint',
    value:
      'Go online to view your dashboard, incentives and scheduled pickups, and to accept ride requests.',
  },
  {
    key: 'ride.incoming.title',
    value: 'Incoming Ride Request',
  },
  {
    key: 'ride.incoming.subtitle',
    value: 'New ride request, please respond',
  },
  {
    key: 'ride.incoming.acceptIn',
    value: 'Accept in',
  },
  {
    key: 'ride.incoming.sec',
    value: 'sec',
  },
  {
    key: 'ride.incoming.earning',
    value: 'Your Earning',
  },
  {
    key: 'ride.incoming.accept',
    value: 'Accept the Ride',
  },
  {
    key: 'ride.incoming.decline',
    value: 'Decline',
  },
  {
    key: 'common.continue',
    value: 'Continue',
  },
  {
    key: 'common.cancel',
    value: 'Cancel',
  },
  {
    key: 'common.save',
    value: 'Save',
  },
  {
    key: 'common.loading',
    value: 'Loading…',
  },
];

/**
 * Seeds app themes, fonts, locales, and driver English translations.
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

  const existing = await prisma.systemSetting.findUnique({ where: { key: 'app_config.version' } });
  const nextVersion = existing?.value ? String(Number.parseInt(existing.value, 10) + 1 || 2) : '1';
  await prisma.systemSetting.upsert({
    where: { key: 'app_config.version' },
    create: {
      key: 'app_config.version',
      value: '1',
      category: 'app_config',
      description: 'Public app-config bundle version (ETag / cache bust)',
      version: 1,
    },
    update: {
      value: nextVersion,
    },
  });
}
