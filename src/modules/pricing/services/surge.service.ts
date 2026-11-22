import { SurgeRepository } from '../repositories/surge.repository.js';
import { PricingMetrics } from '../metrics/pricing.metrics.js';
import { isWithinPeakWindow, surgeWindowVehicleIds } from '../utils/peak-window.js';
import { SURGE_FEATURE_FLAG_KEY, type FeatureFlagReader } from '../constants.js';
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

export interface ResolvedSurge {
  multiplier: number;
  windowId: string | null;
  reason: string | null;
}

const NO_SURGE: ResolvedSurge = Object.freeze({
  multiplier: DEFAULT_SURGE_MULTIPLIER,
  windowId: null,
  reason: null,
});

export class SurgeService {
  constructor(
    private readonly surgeRepository: SurgeRepository,
    private readonly pricingMetrics: PricingMetrics,
    private readonly featureFlagService: FeatureFlagReader,
  ) {}

  /// Phase 2.3 (M-08): Resolves the winning surge window (multiplier + windowId + reason)
  /// for each vehicle type at one pickup point using deterministic highest-wins precedence
  /// (ties broken by latest `startsAt`, then deterministic `id`) clamped to city & platform caps.
  ///
  /// FR-016. Failing open to 1.0 is right for availability: a booking must not fail
  /// because surge lookup did. The metric is what keeps that from being silent.
  async resolveSurgeDetailsForTypes(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeIds: readonly string[],
    options: SurgeOptions = {},
  ): Promise<Map<string, ResolvedSurge>> {
    const fallback = new Map(vehicleTypeIds.map((id) => [id, NO_SURGE] as const));
    try {
      if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
        logger.warn({ pickupLat, pickupLng }, '[SurgeService] Invalid coordinates provided');
        return fallback;
      }
      if (!(await this.featureFlagService.isOn(SURGE_FEATURE_FLAG_KEY))) return fallback;

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
      const resolved = new Map<string, ResolvedSurge>();

      for (const vehicleTypeId of vehicleTypeIds) {
        let bestMultiplier = DEFAULT_SURGE_MULTIPLIER;
        let winningWindow: (typeof windows)[number] | null = null;

        for (const window of windows) {
          const ids = surgeWindowVehicleIds(window);
          if (ids.length > 0 && !ids.includes(vehicleTypeId)) continue;
          if (!isWithinPeakWindow(window, at, timeZone)) continue;
          const value = Number(window.multiplier);
          if (!Number.isFinite(value) || value <= MIN_SURGE_MULTIPLIER) continue;

          const isHigher = value > bestMultiplier;
          const isTieBreakWin =
            value === bestMultiplier &&
            winningWindow !== null &&
            ((window.startsAt?.getTime() ?? 0) > (winningWindow.startsAt?.getTime() ?? 0) ||
              ((window.startsAt?.getTime() ?? 0) === (winningWindow.startsAt?.getTime() ?? 0) &&
                String(window.id ?? '') > String(winningWindow.id ?? '')));

          if (isHigher || isTieBreakWin) {
            bestMultiplier = value;
            winningWindow = window;
          }
        }

        const clamped = Math.max(MIN_SURGE_MULTIPLIER, Math.min(cap, bestMultiplier));
        resolved.set(
          vehicleTypeId,
          clamped > MIN_SURGE_MULTIPLIER && winningWindow
            ? {
                multiplier: clamped,
                windowId: winningWindow.id ?? null,
                reason: winningWindow.reason ?? null,
              }
            : NO_SURGE,
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

  async resolveSurgeDetail(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeId: string,
    options: SurgeOptions = {},
  ): Promise<ResolvedSurge> {
    const resolved = await this.resolveSurgeDetailsForTypes(
      pickupLat,
      pickupLng,
      [vehicleTypeId],
      options,
    );
    return resolved.get(vehicleTypeId) ?? NO_SURGE;
  }

  async resolveSurgeMultipliersForTypes(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeIds: readonly string[],
    options: SurgeOptions = {},
  ): Promise<Map<string, number>> {
    const details = await this.resolveSurgeDetailsForTypes(
      pickupLat,
      pickupLng,
      vehicleTypeIds,
      options,
    );
    return new Map(
      vehicleTypeIds.map((id) => [id, details.get(id)?.multiplier ?? DEFAULT_SURGE_MULTIPLIER]),
    );
  }

  async resolveSurgeMultiplier(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeId: string,
    options: SurgeOptions = {},
  ): Promise<number> {
    const detail = await this.resolveSurgeDetail(pickupLat, pickupLng, vehicleTypeId, options);
    return detail.multiplier;
  }
}
