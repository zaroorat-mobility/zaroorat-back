import type { DatabaseService, TransactionManager } from '@core/database';
import { geoConfig } from '@config/geo/geo.config.js';
import { otpConfig } from '@config/otp/otp.config.js';
import { rideConfig } from '@config/ride/ride.config.js';
import { driverConfig } from '@config/driver/driver.config.js';
import { vehicleConfig } from '@config/vehicle/vehicle.config.js';
import { recordAdminAction } from '../../../audit/index.js';
import { SystemSettingService } from '../../services/system-setting.service.js';
import { SystemSettingsCache } from '../../cache/system-settings.cache.js';
import { PlatformConfigResolver } from './platform-config-resolver.service.js';
import { FeatureFlagService } from './feature-flag.service.js';
import {
  GENERAL_SETTING_KEYS,
  RIDE_SETTING_KEYS,
  OTP_SETTING_KEYS,
  ONBOARDING_SETTING_KEYS,
  MAINTENANCE_SETTING_KEYS,
  GENERAL_SETTINGS_CATEGORY,
  RIDE_SETTINGS_CATEGORY,
  OTP_SETTINGS_CATEGORY,
  ONBOARDING_SETTINGS_CATEGORY,
  MAINTENANCE_SETTINGS_CATEGORY,
} from '../constants/platform-settings.constants.js';
import type {
  UpdateGeneralSettingsBody,
  UpdateRideSettingsBody,
  UpdateOtpSettingsBody,
  UpdateOnboardingSettingsBody,
  UpdateFeatureFlagsBody,
  UpdateMaintenanceSettingsBody,
} from '../schemas/platform-settings.schema.js';

type SettingField<T> = { value: T; source: 'database' | 'default' };

function withSource<T>(
  dbValue: string | null | undefined,
  defaultValue: T,
  parser: (v: string) => T,
): SettingField<T> {
  if (dbValue !== null && dbValue !== undefined && dbValue !== '') {
    return { value: parser(dbValue), source: 'database' };
  }
  return { value: defaultValue, source: 'default' };
}

export class AdminPlatformSettingsService {
  constructor(
    private readonly systemSettingService: SystemSettingService,
    private readonly systemSettingsCache: SystemSettingsCache,
    private readonly platformConfigResolver: PlatformConfigResolver,
    private readonly featureFlagService: FeatureFlagService,
    private readonly databaseService: DatabaseService,
    private readonly txManager: TransactionManager,
  ) {}

  private get client() {
    return this.databaseService.client;
  }

  async getGeneralSettings() {
    const s = await this.systemSettingService.getCategorySettings(GENERAL_SETTINGS_CATEGORY);
    return {
      platformName: withSource(
        s.get(GENERAL_SETTING_KEYS.PLATFORM_NAME)?.value,
        'Zaroorat',
        (v) => v,
      ),
      logoUrl: withSource(s.get(GENERAL_SETTING_KEYS.LOGO_URL)?.value, '', (v) => v),
      supportPhone: withSource(s.get(GENERAL_SETTING_KEYS.SUPPORT_PHONE)?.value, '', (v) => v),
      supportEmail: withSource(s.get(GENERAL_SETTING_KEYS.SUPPORT_EMAIL)?.value, '', (v) => v),
      defaultLanguage: withSource(
        s.get(GENERAL_SETTING_KEYS.DEFAULT_LANGUAGE)?.value,
        'en',
        (v) => v,
      ),
      timezone: withSource(s.get(GENERAL_SETTING_KEYS.TIMEZONE)?.value, 'Asia/Kolkata', (v) => v),
      currency: withSource(s.get(GENERAL_SETTING_KEYS.CURRENCY)?.value, 'INR', (v) => v),
    };
  }

  async updateGeneralSettings(body: UpdateGeneralSettingsBody, actorId?: string) {
    await this.saveSettings(
      GENERAL_SETTINGS_CATEGORY,
      [
        { key: GENERAL_SETTING_KEYS.PLATFORM_NAME, value: body.platformName },
        { key: GENERAL_SETTING_KEYS.LOGO_URL, value: body.logoUrl },
        { key: GENERAL_SETTING_KEYS.SUPPORT_PHONE, value: body.supportPhone },
        { key: GENERAL_SETTING_KEYS.SUPPORT_EMAIL, value: body.supportEmail },
        { key: GENERAL_SETTING_KEYS.DEFAULT_LANGUAGE, value: body.defaultLanguage },
        { key: GENERAL_SETTING_KEYS.TIMEZONE, value: body.timezone },
        { key: GENERAL_SETTING_KEYS.CURRENCY, value: body.currency },
      ],
      actorId,
      'general_settings',
    );
    return this.getGeneralSettings();
  }

  async getRideSettings() {
    const s = await this.systemSettingService.getCategorySettings(RIDE_SETTINGS_CATEGORY);
    return {
      requestExpiryMinutes: withSource(
        s.get(RIDE_SETTING_KEYS.REQUEST_EXPIRY_MINUTES)?.value,
        rideConfig.requestExpiryMinutes,
        Number.parseInt,
      ),
      dispatchTimeoutSeconds: withSource(
        s.get(RIDE_SETTING_KEYS.DISPATCH_TIMEOUT_SECONDS)?.value,
        rideConfig.dispatchTimeoutSeconds,
        Number.parseInt,
      ),
      dispatchBatchSize: withSource(
        s.get(RIDE_SETTING_KEYS.DISPATCH_BATCH_SIZE)?.value,
        rideConfig.dispatchBatchSize,
        Number.parseInt,
      ),
      searchRadiusMeters: withSource(
        s.get(RIDE_SETTING_KEYS.SEARCH_RADIUS_METERS)?.value,
        geoConfig.searchRadiusMeters,
        Number.parseInt,
      ),
      maxSearchRadiusMeters: withSource(
        s.get(RIDE_SETTING_KEYS.MAX_SEARCH_RADIUS_METERS)?.value,
        geoConfig.maxSearchRadiusMeters,
        Number.parseInt,
      ),
      cancellationGraceMinutes: withSource(
        s.get(RIDE_SETTING_KEYS.CANCELLATION_GRACE_MINUTES)?.value,
        rideConfig.cancellationGraceMinutes,
        Number.parseInt,
      ),
      defaultCancellationFee: withSource(
        s.get(RIDE_SETTING_KEYS.DEFAULT_CANCELLATION_FEE)?.value,
        rideConfig.defaultCancellationFee,
        Number.parseFloat,
      ),
    };
  }

  async updateRideSettings(body: UpdateRideSettingsBody, actorId?: string) {
    await this.saveSettings(
      RIDE_SETTINGS_CATEGORY,
      [
        {
          key: RIDE_SETTING_KEYS.REQUEST_EXPIRY_MINUTES,
          value: body.requestExpiryMinutes?.toString(),
        },
        {
          key: RIDE_SETTING_KEYS.DISPATCH_TIMEOUT_SECONDS,
          value: body.dispatchTimeoutSeconds?.toString(),
        },
        { key: RIDE_SETTING_KEYS.DISPATCH_BATCH_SIZE, value: body.dispatchBatchSize?.toString() },
        { key: RIDE_SETTING_KEYS.SEARCH_RADIUS_METERS, value: body.searchRadiusMeters?.toString() },
        {
          key: RIDE_SETTING_KEYS.MAX_SEARCH_RADIUS_METERS,
          value: body.maxSearchRadiusMeters?.toString(),
        },
        {
          key: RIDE_SETTING_KEYS.CANCELLATION_GRACE_MINUTES,
          value: body.cancellationGraceMinutes?.toString(),
        },
        {
          key: RIDE_SETTING_KEYS.DEFAULT_CANCELLATION_FEE,
          value: body.defaultCancellationFee?.toString(),
        },
      ],
      actorId,
      'ride_settings',
    );
    return this.getRideSettings();
  }

  async getOtpSettings() {
    const s = await this.systemSettingService.getCategorySettings(OTP_SETTINGS_CATEGORY);
    return {
      enabled: withSource(s.get(OTP_SETTING_KEYS.ENABLED)?.value, true, (v) => v === 'true'),
      codeLength: withSource(
        s.get(OTP_SETTING_KEYS.CODE_LENGTH)?.value,
        otpConfig.codeLength,
        Number.parseInt,
      ),
      ttlSeconds: withSource(
        s.get(OTP_SETTING_KEYS.TTL_SECONDS)?.value,
        otpConfig.ttlSeconds,
        Number.parseInt,
      ),
      maxVerifyAttempts: withSource(
        s.get(OTP_SETTING_KEYS.MAX_VERIFY_ATTEMPTS)?.value,
        otpConfig.maxVerifyAttempts,
        Number.parseInt,
      ),
      lockoutSeconds: withSource(
        s.get(OTP_SETTING_KEYS.LOCKOUT_SECONDS)?.value,
        otpConfig.lockoutSeconds,
        Number.parseInt,
      ),
      resendIntervalSeconds: withSource(
        s.get(OTP_SETTING_KEYS.RESEND_INTERVAL_SECONDS)?.value,
        otpConfig.resendIntervalSeconds,
        Number.parseInt,
      ),
    };
  }

  async updateOtpSettings(body: UpdateOtpSettingsBody, actorId?: string) {
    await this.saveSettings(
      OTP_SETTINGS_CATEGORY,
      [
        {
          key: OTP_SETTING_KEYS.ENABLED,
          value: body.enabled !== undefined ? String(body.enabled) : undefined,
        },
        { key: OTP_SETTING_KEYS.CODE_LENGTH, value: body.codeLength?.toString() },
        { key: OTP_SETTING_KEYS.TTL_SECONDS, value: body.ttlSeconds?.toString() },
        { key: OTP_SETTING_KEYS.MAX_VERIFY_ATTEMPTS, value: body.maxVerifyAttempts?.toString() },
        { key: OTP_SETTING_KEYS.LOCKOUT_SECONDS, value: body.lockoutSeconds?.toString() },
        {
          key: OTP_SETTING_KEYS.RESEND_INTERVAL_SECONDS,
          value: body.resendIntervalSeconds?.toString(),
        },
      ],
      actorId,
      'otp_settings',
    );
    return this.getOtpSettings();
  }

  async getOnboardingSettings() {
    const s = await this.systemSettingService.getCategorySettings(ONBOARDING_SETTINGS_CATEGORY);
    return {
      driverRequiredDocuments: withSource(
        s.get(ONBOARDING_SETTING_KEYS.DRIVER_REQUIRED_DOCUMENTS)?.value,
        driverConfig.requiredDocumentTypes,
        (v) =>
          v
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean),
      ),
      vehicleRequiredDocuments: withSource(
        s.get(ONBOARDING_SETTING_KEYS.VEHICLE_REQUIRED_DOCUMENTS)?.value,
        vehicleConfig.requiredDocumentTypes,
        (v) =>
          v
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean),
      ),
      driverDocExpiryWarningDays: withSource(
        s.get(ONBOARDING_SETTING_KEYS.DRIVER_DOC_EXPIRY_WARNING_DAYS)?.value,
        30,
        Number.parseInt,
      ),
      requireApprovedDocuments: withSource(
        s.get(ONBOARDING_SETTING_KEYS.REQUIRE_APPROVED_DOCUMENTS)?.value,
        driverConfig.requireApprovedDocuments,
        (v) => v === 'true',
      ),
    };
  }

  async updateOnboardingSettings(body: UpdateOnboardingSettingsBody, actorId?: string) {
    await this.saveSettings(
      ONBOARDING_SETTINGS_CATEGORY,
      [
        {
          key: ONBOARDING_SETTING_KEYS.DRIVER_REQUIRED_DOCUMENTS,
          value: body.driverRequiredDocuments?.join(','),
        },
        {
          key: ONBOARDING_SETTING_KEYS.VEHICLE_REQUIRED_DOCUMENTS,
          value: body.vehicleRequiredDocuments?.join(','),
        },
        {
          key: ONBOARDING_SETTING_KEYS.DRIVER_DOC_EXPIRY_WARNING_DAYS,
          value: body.driverDocExpiryWarningDays?.toString(),
        },
        {
          key: ONBOARDING_SETTING_KEYS.REQUIRE_APPROVED_DOCUMENTS,
          value:
            body.requireApprovedDocuments !== undefined
              ? String(body.requireApprovedDocuments)
              : undefined,
        },
      ],
      actorId,
      'onboarding_settings',
    );
    return this.getOnboardingSettings();
  }

  async getFeatureFlags() {
    const flags = await this.featureFlagService.listFlags();
    return flags.map((f) => ({
      id: f.id,
      key: f.key,
      name: f.name,
      description: f.description,
      status: f.status,
      rolloutPercentage: f.rolloutPercentage,
      isActive: f.isActive,
    }));
  }

  async updateFeatureFlags(body: UpdateFeatureFlagsBody, actorId?: string) {
    for (const flag of body.flags) {
      await this.featureFlagService.updateFlag(flag.key, {
        ...(flag.status !== undefined ? { status: flag.status } : {}),
        ...(flag.rolloutPercentage !== undefined
          ? { rolloutPercentage: flag.rolloutPercentage }
          : {}),
        ...(flag.isActive !== undefined ? { isActive: flag.isActive } : {}),
      });
    }
    if (actorId) {
      await recordAdminAction(this.client, {
        actorId,
        action: 'UPDATE',
        entityType: 'feature_flags',
        summary: `Updated ${body.flags.length} feature flag(s)`,
        after: body.flags,
      });
    }
    return this.getFeatureFlags();
  }

  async getMaintenanceSettings() {
    const config = await this.platformConfigResolver.getMaintenanceConfig();
    const now = new Date();
    const activeWindow = await this.client.maintenanceWindow.findFirst({
      where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
      orderBy: { startsAt: 'desc' },
    });
    const scheduled = await this.client.maintenanceWindow.findMany({
      where: { isActive: true, endsAt: { gte: now } },
      orderBy: { startsAt: 'asc' },
      take: 10,
    });
    return {
      enabled: config.enabled || Boolean(activeWindow),
      message: config.message,
      allowAdminAccess: config.allowAdminAccess,
      activeWindow,
      scheduled,
    };
  }

  async updateMaintenanceSettings(body: UpdateMaintenanceSettingsBody, actorId?: string) {
    await this.saveSettings(
      MAINTENANCE_SETTINGS_CATEGORY,
      [
        {
          key: MAINTENANCE_SETTING_KEYS.ENABLED,
          value: body.enabled !== undefined ? String(body.enabled) : undefined,
        },
        { key: MAINTENANCE_SETTING_KEYS.MESSAGE, value: body.message },
        {
          key: MAINTENANCE_SETTING_KEYS.ALLOW_ADMIN_ACCESS,
          value: body.allowAdminAccess !== undefined ? String(body.allowAdminAccess) : undefined,
        },
      ],
      actorId,
      'maintenance_settings',
    );

    if (body.schedule) {
      await this.client.maintenanceWindow.create({
        data: {
          title: body.schedule.title,
          description: body.schedule.description ?? null,
          startsAt: new Date(body.schedule.startsAt),
          endsAt: new Date(body.schedule.endsAt),
          affectedServices: body.schedule.affectedServices ?? ['api'],
          isActive: true,
        },
      });
    }

    return this.getMaintenanceSettings();
  }

  async isMaintenanceActive(): Promise<{
    active: boolean;
    message: string;
    allowAdminAccess: boolean;
  }> {
    const config = await this.platformConfigResolver.getMaintenanceConfig();
    const now = new Date();
    const activeWindow = await this.client.maintenanceWindow.findFirst({
      where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
    });
    const active = config.enabled || Boolean(activeWindow);
    return { active, message: config.message, allowAdminAccess: config.allowAdminAccess };
  }

  private async saveSettings(
    category: string,
    entries: Array<{ key: string; value: string | undefined }>,
    actorId: string | undefined,
    entityType: string,
  ): Promise<void> {
    await this.txManager.execute(async (tx) => {
      for (const entry of entries) {
        if (entry.value === undefined) continue;
        await this.systemSettingService.setSetting(
          {
            key: entry.key,
            value: entry.value,
            category,
            ...(actorId ? { updatedBy: actorId } : {}),
          },
          tx,
        );
      }
      if (actorId) {
        await recordAdminAction(tx, {
          actorId,
          action: 'UPDATE',
          entityType,
          summary: `Updated ${entityType.replace('_', ' ')}`,
          after: Object.fromEntries(
            entries.filter((e) => e.value !== undefined).map((e) => [e.key, e.value]),
          ),
        });
      }
    });
    await this.systemSettingsCache.invalidateCategory(category);
  }
}
