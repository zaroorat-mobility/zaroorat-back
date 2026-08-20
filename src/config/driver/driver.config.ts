export interface DriverConfig {
  heartbeatTimeoutSeconds: number;
  maxContinuousShiftHours: number;
  requireApprovedDocuments: boolean;
  rejectMockLocation: boolean;
  locationMaxSpeedKmh: number;
  locationMaxAgeSeconds: number;
  locationNoiseFloorMeters: number;
}
export const driverConfig: DriverConfig = Object.freeze({
  heartbeatTimeoutSeconds: Number(process.env.DRIVER_HEARTBEAT_TIMEOUT_SECONDS ?? 300),
  maxContinuousShiftHours: Number(process.env.DRIVER_MAX_SHIFT_HOURS ?? 12),
  requireApprovedDocuments: process.env.DRIVER_REQUIRE_APPROVED_DOCS !== 'false',
  rejectMockLocation: process.env.DRIVER_REJECT_MOCK_LOCATION !== 'false',
  locationMaxSpeedKmh: Number(process.env.DRIVER_LOCATION_MAX_SPEED_KMH ?? 200),
  locationMaxAgeSeconds: Number(process.env.DRIVER_LOCATION_MAX_AGE_SEC ?? 120),
  locationNoiseFloorMeters: Number(process.env.DRIVER_LOCATION_NOISE_FLOOR_M ?? 50),
});
