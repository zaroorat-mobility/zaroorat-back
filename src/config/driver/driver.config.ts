import type { DriverDocumentTypeEnum } from '@modules/drivers/constants/driver.constants';
import { geoConfig } from '../geo/geo.config.js';

export interface DriverConfig {
  heartbeatTimeoutSeconds: number;
  maxContinuousShiftHours: number;
  requireApprovedDocuments: boolean;
  requiredDocumentTypes: DriverDocumentTypeEnum[];
  rejectMockLocation: boolean;
  locationMaxSpeedKmh: number;
  locationMaxAgeSeconds: number;
  locationNoiseFloorMeters: number;
  /// Age after which the last accepted fix stops being a baseline for the
  /// speed check, so a driver can never be locked out by a stale point.
  locationStaleBaselineSeconds: number;
}

/// Defaults to the live-location TTL — the point at which the platform itself
/// stops treating a stored fix as the driver's live position (it is also the
/// heartbeat timeout's default). Never below the dispatch staleness window:
/// while a fix is fresh enough to dispatch on, every jump from it is checked.
function staleBaselineSeconds(): number {
  const configured = Number(
    process.env.DRIVER_LOCATION_STALE_BASELINE_SEC ?? geoConfig.liveLocationTtlSeconds,
  );
  const value = Number.isFinite(configured) ? configured : geoConfig.liveLocationTtlSeconds;
  return Math.max(value, geoConfig.candidateStalenessSeconds);
}

export const driverConfig: DriverConfig = Object.freeze({
  heartbeatTimeoutSeconds: Number(process.env.DRIVER_HEARTBEAT_TIMEOUT_SECONDS ?? 300),
  maxContinuousShiftHours: Number(process.env.DRIVER_MAX_SHIFT_HOURS ?? 12),
  requireApprovedDocuments: process.env.DRIVER_REQUIRE_APPROVED_DOCS !== 'false',
  // RC and INSURANCE belong to the vehicle (vehicle_documents) and are gated by
  // vehicleConfig.requiredDocumentTypes at go-online; requiring them here as
  // driver documents made every app-onboarded driver unapprovable.
  requiredDocumentTypes: (process.env.DRIVER_REQUIRED_DOCUMENT_TYPES ?? 'DRIVING_LICENSE')
    .split(',')
    .map((s) => s.trim()) as DriverDocumentTypeEnum[],
  rejectMockLocation: process.env.DRIVER_REJECT_MOCK_LOCATION !== 'false',
  locationMaxSpeedKmh: Number(process.env.DRIVER_LOCATION_MAX_SPEED_KMH ?? 200),
  locationMaxAgeSeconds: Number(process.env.DRIVER_LOCATION_MAX_AGE_SEC ?? 120),
  locationNoiseFloorMeters: Number(process.env.DRIVER_LOCATION_NOISE_FLOOR_M ?? 50),
  locationStaleBaselineSeconds: staleBaselineSeconds(),
});
