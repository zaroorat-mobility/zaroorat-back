// Re-export specific types from the generated Prisma Client to avoid deep imports in feature code
export type {
  User,
  Driver,
  Vehicle,
  Ride,
  PaymentTransaction,
  UserStatus,
  RideStatus,
  Prisma,
  // Auth / identity models (consumed by the auth repository layer)
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
  // File custody (consumed by the files repository layer)
  File,
  FilePurpose,
  FileStatus,
} from '../../generated/prisma';
