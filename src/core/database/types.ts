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
} from '../../generated/prisma';
