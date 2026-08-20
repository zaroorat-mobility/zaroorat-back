import type { DriverDocumentTypeEnum } from '@modules/drivers/constants/driver.constants';

export interface DriverConfig {
  heartbeatTimeoutSeconds: number;
  maxContinuousShiftHours: number;
  requireApprovedDocuments: boolean;
  requiredDocumentTypes: DriverDocumentTypeEnum[];
  rejectMockLocation: boolean;
  locationMaxSpeedKmh: number;
  locationMaxAgeSeconds: number;
  locationNoiseFloorMeters: number;
}
export const driverConfig: DriverConfig = Object.freeze({
  heartbeatTimeoutSeconds: Number(process.env.DRIVER_HEARTBEAT_TIMEOUT_SECONDS ?? 300),
  maxContinuousShiftHours: Number(process.env.DRIVER_MAX_SHIFT_HOURS ?? 12),
  requireApprovedDocuments: process.env.DRIVER_REQUIRE_APPROVED_DOCS !== 'false',
  requiredDocumentTypes: (
    process.env.DRIVER_REQUIRED_DOCUMENT_TYPES ?? 'DRIVING_LICENSE,RC,INSURANCE'
  )
    .split(',')
    .map((s) => s.trim()) as DriverDocumentTypeEnum[],
  rejectMockLocation: process.env.DRIVER_REJECT_MOCK_LOCATION !== 'false',
  locationMaxSpeedKmh: Number(process.env.DRIVER_LOCATION_MAX_SPEED_KMH ?? 200),
  locationMaxAgeSeconds: Number(process.env.DRIVER_LOCATION_MAX_AGE_SEC ?? 120),
  locationNoiseFloorMeters: Number(process.env.DRIVER_LOCATION_NOISE_FLOOR_M ?? 50),
});
