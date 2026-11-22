import { Prisma } from '../../../generated/prisma/index.js';
import type {
  Driver,
  DriverProfile,
  DriverDocument,
  DriverBankAccount,
  DriverWallet,
  DriverWalletTransaction,
  DriverOnlineStatus,
  DriverLocation,
  DriverShiftLog,
  DriverVerificationStatus,
  VerificationStatus,
  DriverStatus,
  DriverDocumentType,
} from '../../../generated/prisma/index.js';
export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;
export type {
  Driver,
  DriverProfile,
  DriverDocument,
  DriverBankAccount,
  DriverWallet,
  DriverWalletTransaction,
  DriverOnlineStatus,
  DriverLocation,
  DriverShiftLog,
  DriverVerificationStatus,
  VerificationStatus,
  DriverStatus,
  DriverDocumentType,
};
export interface DocumentEligibilityResult {
  eligible: boolean;
  missing: DriverDocumentType[];
  pending: DriverDocumentType[];
  rejected: DriverDocumentType[];
  expired: DriverDocumentType[];
}
