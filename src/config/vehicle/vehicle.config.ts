export interface VehicleConfig {
  requiredDocumentTypes: string[];

  requireApprovedDocuments: boolean;

  requireVerifiedVehicle: boolean;
}

export const VEHICLE_DOCUMENT_TYPE = {
  RC: 'RC',
  INSURANCE: 'INSURANCE',
  PUC: 'PUC',
  FITNESS: 'FITNESS',
  PERMIT: 'PERMIT',
} as const;

export type VehicleDocumentTypeEnum =
  (typeof VEHICLE_DOCUMENT_TYPE)[keyof typeof VEHICLE_DOCUMENT_TYPE];

export const VEHICLE_DOCUMENT_TYPES: readonly VehicleDocumentTypeEnum[] = Object.freeze(
  Object.values(VEHICLE_DOCUMENT_TYPE),
);

export const vehicleConfig: VehicleConfig = Object.freeze({
  requiredDocumentTypes: (process.env.VEHICLE_REQUIRED_DOCUMENT_TYPES ?? 'RC,INSURANCE')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
  requireApprovedDocuments: process.env.VEHICLE_REQUIRE_APPROVED_DOCS !== 'false',
  requireVerifiedVehicle: process.env.VEHICLE_REQUIRE_VERIFIED !== 'false',
});
