import { SurgeRepository } from '../repositories/surge.repository.js';
import { PricingMetrics } from '../metrics/pricing.metrics.js';
import { isWithinPeakWindow } from '../utils/peak-window.js';
import { logger } from '@shared/logger/index.js';

/// Where peak hours are read when the caller does not know the pickup city's
/// timezone. Every `City` carries one; this is the fallback for a quote taken
/// before coverage is configured (BD-10), not a default anyone should rely on.
const FALLBACK_TIME_ZONE = 'Asia/Kolkata';

export const DEFAULT_SURGE_MULTIPLIER = 1.0;
export const MIN_SURGE_MULTIPLIER = 1.0;
export const MAX_SURGE_MULTIPLIER = 2.0;

export class SurgeService {
  constructor(
    private readonly surgeRepository: SurgeRepository,
    private readonly pricingMetrics: PricingMetrics,
  ) {}

  /**
   * Resolves the applicable surge multiplier for a given pickup location and vehicle type.
   * If multiple surge windows overlap, the highest multiplier is selected.
   * Ensures the returned multiplier is always between MIN_SURGE_MULTIPLIER and MAX_SURGE_MULTIPLIER.
   */
  /// FR-039. One surge resolution for a whole catalog at one point.
  ///
  /// The zone containment query and the window lookup do not depend on the
  /// vehicle type — only the final per-window `vehicleTypeId` filter does. Called
  /// once per category, this ran the same PostGIS ST_Intersects once per row in
  /// the picker.
  async resolveSurgeMultipliersForTypes(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeIds: readonly string[],
    options: {
      timeZone?: string | undefined;
      at?: Date | undefined;
      cityCode?: string | undefined;
    } = {},
  ): Promise<Map<string, number>> {
    const fallback = new Map(vehicleTypeIds.map((id) => [id, DEFAULT_SURGE_MULTIPLIER] as const));
    try {
      if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
        logger.warn({ pickupLat, pickupLng }, '[SurgeService] Invalid coordinates provided');
        return fallback;
      }

      const zones = await this.surgeRepository.findZonesForLocation(
        pickupLat,
        pickupLng,
        options.cityCode,
      );
      if (zones.serviceZoneIds.length === 0 && zones.legacySurgeZoneIds.length === 0) {
        return fallback;
      }

      // Every window for every category, in one query rather than one per
      // category. The per-type filter is applied in memory below.
      const windows = await this.surgeRepository.findActiveWindowsForZones(
        zones.legacySurgeZoneIds,
        undefined,
        zones.serviceZoneIds,
      );
      if (windows.length === 0) return fallback;

      const at = options.at ?? new Date();
      const timeZone = options.timeZone ?? FALLBACK_TIME_ZONE;
      const resolved = new Map<string, number>();

      for (const vehicleTypeId of vehicleTypeIds) {
        let max = DEFAULT_SURGE_MULTIPLIER;
        for (const window of windows) {
          // A window with no vehicle type applies to every category.
          if (window.vehicleTypeId !== null && window.vehicleTypeId !== vehicleTypeId) continue;
          if (!isWithinPeakWindow(window, at, timeZone)) continue;
          const value = Number(window.multiplier);
          if (Number.isFinite(value) && value > max) max = value;
        }
        resolved.set(
          vehicleTypeId,
          Math.max(MIN_SURGE_MULTIPLIER, Math.min(MAX_SURGE_MULTIPLIER, max)),
        );
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
    options: {
      timeZone?: string | undefined;
      at?: Date | undefined;
      cityCode?: string | undefined;
    } = {},
  ): Promise<number> {
    try {
      // 1. Validate coordinates
      if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
        logger.warn({ pickupLat, pickupLng }, '[SurgeService] Invalid coordinates provided');
        return DEFAULT_SURGE_MULTIPLIER;
      }

      // 2. Find the zones containing the pickup point — the geographic module's
      // service zones (BD-4's single polygon of record) and, for one release,
      // the legacy surge polygons that have not been re-pointed yet.
      const zones = await this.surgeRepository.findZonesForLocation(
        pickupLat,
        pickupLng,
        options.cityCode,
      );
      if (zones.serviceZoneIds.length === 0 && zones.legacySurgeZoneIds.length === 0) {
        return DEFAULT_SURGE_MULTIPLIER;
      }

      // 3. Find currently active SurgeWindows for those zones
      const activeWindows = await this.surgeRepository.findActiveWindowsForZones(
        zones.legacySurgeZoneIds,
        vehicleTypeId,
        zones.serviceZoneIds,
      );

      if (activeWindows.length === 0) {
        return DEFAULT_SURGE_MULTIPLIER;
      }

      // 4. Select highest valid multiplier, among windows that are actually in
      // force right now. FR-013: `isPeakHourOnly` and its bounds were stored,
      // validated and returned by the API, and evaluated by nothing — so a
      // window configured for the morning peak surged at 03:00 as well.
      const at = options.at ?? new Date();
      const timeZone = options.timeZone ?? FALLBACK_TIME_ZONE;
      let maxMultiplier = DEFAULT_SURGE_MULTIPLIER;

      for (const window of activeWindows) {
        if (!isWithinPeakWindow(window, at, timeZone)) continue;
        const windowMultiplier = Number(window.multiplier);
        if (Number.isFinite(windowMultiplier) && windowMultiplier > maxMultiplier) {
          maxMultiplier = windowMultiplier;
        }
      }

      // 5. Validate against policy bounds
      maxMultiplier = Math.max(MIN_SURGE_MULTIPLIER, Math.min(MAX_SURGE_MULTIPLIER, maxMultiplier));

      return maxMultiplier;
    } catch (err) {
      // FR-016. Failing open to 1.0 is right for availability — a booking must
      // not fail because surge lookup did. But the whole method was wrapped, so
      // a malformed polygon, a dropped connection and a genuinely quiet zone all
      // produced the same number and the same silence: revenue stopped surging
      // and only the log knew.
      this.pricingMetrics.surgeResolutionFailed();
      logger.error(
        { err, pickupLat, pickupLng },
        '[SurgeService] Error resolving surge multiplier',
      );
      return DEFAULT_SURGE_MULTIPLIER; // Fallback to safe default
    }
  }
}
