/// Mirrors `driverConfig`'s shape and knob-naming exactly — the two eligibility
/// gates are read side by side in `StatusService.setOnline`, so they should be
/// configured the same way.
export interface VehicleConfig {
  /// Vehicle-owned document types a vehicle must hold, VERIFIED and unexpired,
  /// before its driver may go online. Deliberately a *different* list from
  /// `driverConfig.requiredDocumentTypes`: RC and INSURANCE are properties of a
  /// vehicle, not of the person driving it. Driver's list is left untouched
  /// here — narrowing it is a separate, behaviour-changing decision.
  requiredDocumentTypes: string[];
  /// When false, document eligibility is skipped entirely (the vehicle
  /// verification gate below still applies). Same escape hatch, same default,
  /// as `driverConfig.requireApprovedDocuments`.
  requireApprovedDocuments: boolean;
  /// When false, an unverified vehicle no longer blocks going online. Exists so
  /// a market can be launched before an operator review queue is staffed; it is
  /// on by default because an unreviewed vehicle carrying passengers is the
  /// failure this gate exists to prevent.
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
