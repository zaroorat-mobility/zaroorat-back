import { Prisma } from '../../../generated/prisma/index.js';
import type {
  Vehicle,
  VehicleAssignment,
  VehicleDocument,
  VehicleType,
  VerificationStatus,
} from '../../../generated/prisma/index.js';
export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;
export type { Vehicle, VehicleAssignment, VehicleDocument, VehicleType, VerificationStatus };

/// Mirrors `DocumentEligibilityResult` in the drivers module so the two gates
/// report their outcome in the same shape.
export interface VehicleDocumentEligibilityResult {
  eligible: boolean;
  missing: string[];
  pending: string[];
  rejected: string[];
  expired: string[];
}

export type VehicleEligibilityReason =
  'VEHICLE_MISSING' | 'VEHICLE_INACTIVE' | 'VEHICLE_NOT_VERIFIED' | 'VEHICLE_DOCUMENTS_INCOMPLETE';

export type VehicleEligibility =
  | { eligible: true; vehicle: Vehicle }
  | {
      eligible: false;
      reason: VehicleEligibilityReason;
      documents?: VehicleDocumentEligibilityResult;
      verificationStatus?: VerificationStatus;
    };
