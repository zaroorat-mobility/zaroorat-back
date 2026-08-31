export const PLATFORM_SETTINGS_CATEGORY = 'platform';

export const GENERAL_SETTINGS_CATEGORY = 'general';
export const RIDE_SETTINGS_CATEGORY = 'ride';
export const OTP_SETTINGS_CATEGORY = 'otp';
export const ONBOARDING_SETTINGS_CATEGORY = 'onboarding';
export const MAINTENANCE_SETTINGS_CATEGORY = 'maintenance';

export const GENERAL_SETTING_KEYS = Object.freeze({
  PLATFORM_NAME: 'general.platform_name',
  LOGO_URL: 'general.logo_url',
  SUPPORT_PHONE: 'general.support_phone',
  SUPPORT_EMAIL: 'general.support_email',
  DEFAULT_LANGUAGE: 'general.default_language',
  TIMEZONE: 'general.timezone',
  CURRENCY: 'general.currency',
} as const);

export const RIDE_SETTING_KEYS = Object.freeze({
  REQUEST_EXPIRY_MINUTES: 'ride.request_expiry_minutes',
  DISPATCH_TIMEOUT_SECONDS: 'ride.dispatch_timeout_seconds',
  DISPATCH_BATCH_SIZE: 'ride.dispatch_batch_size',
  SEARCH_RADIUS_METERS: 'ride.search_radius_meters',
  MAX_SEARCH_RADIUS_METERS: 'ride.max_search_radius_meters',
  CANCELLATION_GRACE_MINUTES: 'ride.cancellation_grace_minutes',
  DEFAULT_CANCELLATION_FEE: 'ride.default_cancellation_fee',
} as const);

export const OTP_SETTING_KEYS = Object.freeze({
  ENABLED: 'otp.enabled',
  CODE_LENGTH: 'otp.code_length',
  TTL_SECONDS: 'otp.ttl_seconds',
  MAX_VERIFY_ATTEMPTS: 'otp.max_verify_attempts',
  LOCKOUT_SECONDS: 'otp.lockout_seconds',
  RESEND_INTERVAL_SECONDS: 'otp.resend_interval_seconds',
} as const);

export const ONBOARDING_SETTING_KEYS = Object.freeze({
  DRIVER_REQUIRED_DOCUMENTS: 'onboarding.driver_required_documents',
  VEHICLE_REQUIRED_DOCUMENTS: 'onboarding.vehicle_required_documents',
  DRIVER_DOC_EXPIRY_WARNING_DAYS: 'onboarding.driver_doc_expiry_warning_days',
  REQUIRE_APPROVED_DOCUMENTS: 'onboarding.require_approved_documents',
} as const);

export const MAINTENANCE_SETTING_KEYS = Object.freeze({
  ENABLED: 'maintenance.enabled',
  MESSAGE: 'maintenance.message',
  ALLOW_ADMIN_ACCESS: 'maintenance.allow_admin_access',
} as const);

export const FEATURE_FLAG_KEYS = Object.freeze({
  WALLET: 'wallet',
  REFERRALS: 'referrals',
  PROMO_CODES: 'promo_codes',
  SURGE: 'surge',
  SCHEDULED_RIDES: 'scheduled_rides',
  DRIVER_INCENTIVES: 'driver_incentives',
} as const);

export const FEATURE_FLAG_SEED = Object.freeze([
  {
    key: FEATURE_FLAG_KEYS.WALLET,
    name: 'Wallet',
    description: 'In-app wallet payments and top-ups',
  },
  {
    key: FEATURE_FLAG_KEYS.REFERRALS,
    name: 'Referrals',
    description: 'Referral programs and rewards',
  },
  {
    key: FEATURE_FLAG_KEYS.PROMO_CODES,
    name: 'Promo Codes',
    description: 'Promotional codes and campaigns',
  },
  { key: FEATURE_FLAG_KEYS.SURGE, name: 'Surge Pricing', description: 'Dynamic surge pricing' },
  {
    key: FEATURE_FLAG_KEYS.SCHEDULED_RIDES,
    name: 'Scheduled Rides',
    description: 'Book rides in advance',
  },
  {
    key: FEATURE_FLAG_KEYS.DRIVER_INCENTIVES,
    name: 'Driver Incentives',
    description: 'Driver bonus and incentive programs',
  },
] as const);
