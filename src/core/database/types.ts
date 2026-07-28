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
} from '../../generated/prisma';
