import { Prisma } from '../../generated/prisma/index.js';

export type {
  User,
  Driver,
  Vehicle,
  Ride,
  PaymentTransaction,
  UserStatus,
  RideStatus,
  Prisma,
  OtpVerification,
  OtpPurpose,
  UserSession,
  RefreshToken,
  UserDevice,
  DeviceTrustState,
  AppPlatform,
  Role,
  UserRoleAssignment,
  Permission,
  RolePermission,
  File,
  FilePurpose,
  FileStatus,
} from '../../generated/prisma';

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;
