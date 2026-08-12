import { Prisma } from '../../../generated/prisma/index.js';

import type {
  RideRequest,
  RideDispatch,
  Ride,
  RideStop,
  RideStatusEvent,
  RideFare,
  RideFareLine,
  RideCancellation,
  RideOtp,
  RideReceipt,
  RidePayment,
  RideRating,
  RideWaitEvent,
  RideDispute,
  RideStatus,
  RideRequestStatus,
  DispatchResponse,
} from '../../../generated/prisma/index.js';

export type Decimal = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export type {
  RideRequest,
  RideDispatch,
  Ride,
  RideStop,
  RideStatusEvent,
  RideFare,
  RideFareLine,
  RideCancellation,
  RideOtp,
  RideReceipt,
  RidePayment,
  RideRating,
  RideWaitEvent,
  RideDispute,
  RideStatus,
  RideRequestStatus,
  DispatchResponse,
};
