import { SurgeRepository } from '../repositories/surge.repository.js';
import { logger } from '@shared/logger/index.js';

export const DEFAULT_SURGE_MULTIPLIER = 1.0;
export const MIN_SURGE_MULTIPLIER = 1.0;
export const MAX_SURGE_MULTIPLIER = 2.0;

export class SurgeService {
  constructor(private readonly surgeRepository: SurgeRepository) {}

  /**
   * Resolves the applicable surge multiplier for a given pickup location and vehicle type.
   * If multiple surge windows overlap, the highest multiplier is selected.
   * Ensures the returned multiplier is always between MIN_SURGE_MULTIPLIER and MAX_SURGE_MULTIPLIER.
   */
  async resolveSurgeMultiplier(
    pickupLat: number,
    pickupLng: number,
    vehicleTypeId: string,
  ): Promise<number> {
    try {
      // 1. Validate coordinates
      if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
        logger.warn({ pickupLat, pickupLng }, '[SurgeService] Invalid coordinates provided');
        return DEFAULT_SURGE_MULTIPLIER;
      }

      // 2. Find active SurgeZones containing pickup point
      const activeZones = await this.surgeRepository.findActiveZonesForLocation(
        pickupLat,
        pickupLng,
      );
      if (activeZones.length === 0) {
        return DEFAULT_SURGE_MULTIPLIER;
      }

      const zoneIds = activeZones.map((z) => z.id);

      // 3. Find currently active SurgeWindows for those zones
      const activeWindows = await this.surgeRepository.findActiveWindowsForZones(
        zoneIds,
        vehicleTypeId,
      );

      if (activeWindows.length === 0) {
        return DEFAULT_SURGE_MULTIPLIER;
      }

      // 4. Select highest valid multiplier
      let maxMultiplier = DEFAULT_SURGE_MULTIPLIER;

      for (const window of activeWindows) {
        const windowMultiplier = Number(window.multiplier);
        if (Number.isFinite(windowMultiplier) && windowMultiplier > maxMultiplier) {
          maxMultiplier = windowMultiplier;
        }
      }

      // 5. Validate against policy bounds
      maxMultiplier = Math.max(MIN_SURGE_MULTIPLIER, Math.min(MAX_SURGE_MULTIPLIER, maxMultiplier));

      return maxMultiplier;
    } catch (err) {
      logger.error(
        { err, pickupLat, pickupLng },
        '[SurgeService] Error resolving surge multiplier',
      );
      return DEFAULT_SURGE_MULTIPLIER; // Fallback to safe default
    }
  }
}
