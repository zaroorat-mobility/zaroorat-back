import { container } from '@core/di';
import { geoConfig } from '@config/geo/geo.config.js';
import { otpConfig } from '@config/otp/otp.config.js';
import { rideConfig } from '@config/ride/ride.config.js';
import { driverConfig } from '@config/driver/driver.config.js';
import { vehicleConfig } from '@config/vehicle/vehicle.config.js';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { getStorageConfig } from '@modules/files/config/storage.config.js';
import type { StorageProvider } from '@modules/files/utils/storage/storage.provider.js';
import { brandingLogoKey } from './branding-logo-key.js';
import {
  GENERAL_SETTING_KEYS,
  RIDE_SETTING_KEYS,
  OTP_SETTING_KEYS,
  ONBOARDING_SETTING_KEYS,
  MAINTENANCE_SETTING_KEYS,
} from '../constants/platform-settings.constants.js';

function parseBool(value: string | null | undefined, fallback: boolean): boolean {
  if (value === null || value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function parseInt(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloat(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/// Re-signs an uploaded logo so its URL never expires in app config. Only keys
/// `brandingLogoKey` accepts are signed; any other URL is returned as typed.
async function refreshIfS3Url(rawUrl: string): Promise<string> {
  if (!rawUrl) return '';
  try {
    const key = brandingLogoKey(rawUrl, getStorageConfig().bucket);
    if (!key) return rawUrl;
    if (container.hasRegistration('storageProvider')) {
      const storageProvider = container.resolve<StorageProvider>('storageProvider');
      const signed = await storageProvider.signDownload({
        key,
        ttlSeconds: 604800, // 7 days (maximum AWS S3 SigV4 presigned duration)
        contentType: key.endsWith('.png')
          ? 'image/png'
          : key.endsWith('.webp')
            ? 'image/webp'
            : 'image/jpeg',
        disposition: 'inline',
        fileName: 'brand-logo.png',
      });
      return signed.url;
    }
  } catch (err) {
    console.error('[refreshIfS3Url] Error refreshing S3 download URL:', err);
  }
  return rawUrl;
}

export class PlatformConfigResolver {
  constructor(private readonly systemSettingService: SystemSettingService) {}

  async getGeneralConfig(app?: string) {
    const s = await this.systemSettingService.getCategorySettings('general');
    const masterLogoRaw = s.get(GENERAL_SETTING_KEYS.LOGO_URL)?.value ?? '';
    const customerLogoRaw = s.get(GENERAL_SETTING_KEYS.CUSTOMER_LOGO_URL)?.value ?? '';
    const driverLogoRaw = s.get(GENERAL_SETTING_KEYS.DRIVER_LOGO_URL)?.value ?? '';

    const [masterLogo, customerLogo, driverLogo] = await Promise.all([
      refreshIfS3Url(masterLogoRaw),
      refreshIfS3Url(customerLogoRaw),
      refreshIfS3Url(driverLogoRaw),
    ]);

    let resolvedLogo = masterLogo;
    if (app === 'driver') {
      resolvedLogo = driverLogo || masterLogo;
    } else if (app === 'rider') {
      resolvedLogo = customerLogo || masterLogo;
    }

    return {
      platformName: s.get(GENERAL_SETTING_KEYS.PLATFORM_NAME)?.value ?? 'Zaroorat',
      logoUrl: resolvedLogo,
      customerLogoUrl: customerLogo || masterLogo,
      driverLogoUrl: driverLogo || masterLogo,
      supportPhone: s.get(GENERAL_SETTING_KEYS.SUPPORT_PHONE)?.value ?? '',
      supportEmail: s.get(GENERAL_SETTING_KEYS.SUPPORT_EMAIL)?.value ?? '',
      defaultLanguage: s.get(GENERAL_SETTING_KEYS.DEFAULT_LANGUAGE)?.value ?? 'en',
      timezone: s.get(GENERAL_SETTING_KEYS.TIMEZONE)?.value ?? 'Asia/Kolkata',
      currency: s.get(GENERAL_SETTING_KEYS.CURRENCY)?.value ?? 'INR',
    };
  }

  async getRideConfig() {
    const s = await this.systemSettingService.getCategorySettings('ride');
    return {
      requestExpiryMinutes: parseInt(
        s.get(RIDE_SETTING_KEYS.REQUEST_EXPIRY_MINUTES)?.value,
        rideConfig.requestExpiryMinutes,
      ),
      dispatchTimeoutSeconds: parseInt(
        s.get(RIDE_SETTING_KEYS.DISPATCH_TIMEOUT_SECONDS)?.value,
        rideConfig.dispatchTimeoutSeconds,
      ),
      dispatchBatchSize: parseInt(
        s.get(RIDE_SETTING_KEYS.DISPATCH_BATCH_SIZE)?.value,
        rideConfig.dispatchBatchSize,
      ),
      searchRadiusMeters: parseInt(
        s.get(RIDE_SETTING_KEYS.SEARCH_RADIUS_METERS)?.value,
        geoConfig.searchRadiusMeters,
      ),
      maxSearchRadiusMeters: parseInt(
        s.get(RIDE_SETTING_KEYS.MAX_SEARCH_RADIUS_METERS)?.value,
        geoConfig.maxSearchRadiusMeters,
      ),
      cancellationGraceMinutes: parseInt(
        s.get(RIDE_SETTING_KEYS.CANCELLATION_GRACE_MINUTES)?.value,
        rideConfig.cancellationGraceMinutes,
      ),
      defaultCancellationFee: parseFloat(
        s.get(RIDE_SETTING_KEYS.DEFAULT_CANCELLATION_FEE)?.value,
        rideConfig.defaultCancellationFee,
      ),
    };
  }

  async getOtpConfig() {
    const s = await this.systemSettingService.getCategorySettings('otp');
    return {
      enabled: parseBool(s.get(OTP_SETTING_KEYS.ENABLED)?.value, true),
      codeLength: parseInt(s.get(OTP_SETTING_KEYS.CODE_LENGTH)?.value, otpConfig.codeLength),
      ttlSeconds: parseInt(s.get(OTP_SETTING_KEYS.TTL_SECONDS)?.value, otpConfig.ttlSeconds),
      maxVerifyAttempts: parseInt(
        s.get(OTP_SETTING_KEYS.MAX_VERIFY_ATTEMPTS)?.value,
        otpConfig.maxVerifyAttempts,
      ),
      lockoutSeconds: parseInt(
        s.get(OTP_SETTING_KEYS.LOCKOUT_SECONDS)?.value,
        otpConfig.lockoutSeconds,
      ),
      resendIntervalSeconds: parseInt(
        s.get(OTP_SETTING_KEYS.RESEND_INTERVAL_SECONDS)?.value,
        otpConfig.resendIntervalSeconds,
      ),
    };
  }

  async getOnboardingConfig() {
    const s = await this.systemSettingService.getCategorySettings('onboarding');
    const driverDocs =
      s.get(ONBOARDING_SETTING_KEYS.DRIVER_REQUIRED_DOCUMENTS)?.value ??
      driverConfig.requiredDocumentTypes.join(',');
    const vehicleDocs =
      s.get(ONBOARDING_SETTING_KEYS.VEHICLE_REQUIRED_DOCUMENTS)?.value ??
      vehicleConfig.requiredDocumentTypes.join(',');
    return {
      driverRequiredDocuments: driverDocs
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      vehicleRequiredDocuments: vehicleDocs
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
      driverDocExpiryWarningDays: parseInt(
        s.get(ONBOARDING_SETTING_KEYS.DRIVER_DOC_EXPIRY_WARNING_DAYS)?.value,
        30,
      ),
      requireApprovedDocuments: parseBool(
        s.get(ONBOARDING_SETTING_KEYS.REQUIRE_APPROVED_DOCUMENTS)?.value,
        driverConfig.requireApprovedDocuments,
      ),
    };
  }

  async getMaintenanceConfig() {
    const s = await this.systemSettingService.getCategorySettings('maintenance');
    return {
      enabled: parseBool(s.get(MAINTENANCE_SETTING_KEYS.ENABLED)?.value, false),
      message:
        s.get(MAINTENANCE_SETTING_KEYS.MESSAGE)?.value ??
        'The platform is under maintenance. Please try again later.',
      allowAdminAccess: parseBool(s.get(MAINTENANCE_SETTING_KEYS.ALLOW_ADMIN_ACCESS)?.value, true),
    };
  }
}
