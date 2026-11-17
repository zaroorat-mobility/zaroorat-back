import { SurgeRepository } from '../repositories/surge.repository.js';
import { PricingMetrics } from '../metrics/pricing.metrics.js';
import { isWithinPeakWindow, surgeWindowVehicleIds } from '../utils/peak-window.js';
import { FEATURE_FLAG_KEYS } from '@modules/admin/system-settings/platform/constants/platform-settings.constants.js';
import type { FeatureFlagService } from '@modules/admin/system-settings/platform/services/feature-flag.service.js';
import { logger } from '@shared/logger/index.js';

/// Where peak hours are read when the caller does not know the pickup city's
/// timezone. Every `City` carries one; this is the fallback for a quote taken
/// before coverage is configured (BD-10), not a default anyone should rely on.
export const FALLBACK_TIME_ZONE = 'Asia/Kolkata';

export const DEFAULT_SURGE_MULTIPLIER = 1.0;
export const MIN_SURGE_MULTIPLIER = 1.0;
export const MAX_SURGE_MULTIPLIER = 2.0;

export interface SurgeOptions {
  timeZone?: string | undefined;
  at?: Date | undefined;
  cityCode?: string | undefined;
  /// The legal cap in the pickup city. Never raises the platform limit.
  maxMultiplier?: number | undefined;
}

export class SurgeService {
  constructor(
    private readonly surgeRepository: SurgeRepository,
    private readonly pricingMetrics: PricingMetrics,
    private readonly featureFlagService: FeatureFlagService,
  ) {}

  /// The multiplier for each vehicle type at this point: the highest rule in force,
  /// within the city cap and the platform limit.
  ///
  /// FR-039. One resolution for a whole catalog at one point. The zone containment
  /// query and the window lookup do not depend on the vehicle type, so running them
  /// per category repeated the same PostGIS query once per row in the picker.
  ///
  /// FR-016. Failing open to 1.0 is right for availability: a booking must not fail
  /// because surge lookup did. The metric is what keeps that from being silent.
  async resolveSurgeMultipliersForTypes(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeIds: readonly string[],
    options: SurgeOptions = {},
  ): Promise<Map<string, number>> {
    const fallback = new Map(vehicleTypeIds.map((id) => [id, DEFAULT_SURGE_MULTIPLIER] as const));
    try {
      if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
        logger.warn({ pickupLat, pickupLng }, '[SurgeService] Invalid coordinates provided');
        return fallback;
      }
      if (!(await this.featureFlagService.isOn(FEATURE_FLAG_KEYS.SURGE))) return fallback;

      const at = options.at ?? new Date();
      const zones = await this.surgeRepository.findZonesForLocation(
        pickupLat,
        pickupLng,
        options.cityCode,
      );
      const cityCode = options.cityCode !== 'GLOBAL' ? options.cityCode : undefined;
      if (zones.serviceZoneIds.length === 0 && zones.legacySurgeZoneIds.length === 0 && !cityCode) {
        return fallback;
      }

      const windows = await this.surgeRepository.findActiveWindowsForZones(
        zones.legacySurgeZoneIds,
        zones.serviceZoneIds,
        cityCode,
        at,
      );
      if (windows.length === 0) return fallback;

      const timeZone = options.timeZone ?? FALLBACK_TIME_ZONE;
      const cap = Math.min(options.maxMultiplier ?? MAX_SURGE_MULTIPLIER, MAX_SURGE_MULTIPLIER);
      const resolved = new Map<string, number>();

      for (const vehicleTypeId of vehicleTypeIds) {
        let max = DEFAULT_SURGE_MULTIPLIER;
        for (const window of windows) {
          const ids = surgeWindowVehicleIds(window);
          if (ids.length > 0 && !ids.includes(vehicleTypeId)) continue;
          if (!isWithinPeakWindow(window, at, timeZone)) continue;
          const value = Number(window.multiplier);
          if (Number.isFinite(value) && value > max) max = value;
        }
        resolved.set(vehicleTypeId, Math.max(MIN_SURGE_MULTIPLIER, Math.min(cap, max)));
      }
      return resolved;
    } catch (err) {
      this.pricingMetrics.surgeResolutionFailed();
      logger.error(
        { err, pickupLat, pickupLng },
        '[SurgeService] Error resolving surge multipliers',
      );
      return fallback;
    }
  }

  async resolveSurgeMultiplier(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeId: string,
    options: SurgeOptions = {},
  ): Promise<number> {
    const resolved = await this.resolveSurgeMultipliersForTypes(
      pickupLat,
      pickupLng,
      [vehicleTypeId],
      options,
    );
    return resolved.get(vehicleTypeId) ?? DEFAULT_SURGE_MULTIPLIER;
  }
}
