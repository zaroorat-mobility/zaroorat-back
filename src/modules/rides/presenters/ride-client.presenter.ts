/**
 * Shapes Prisma ride / offer rows for customer + driver mobile clients.
 * Backend never returns the Ride PIN plaintext — only party/vehicle details.
 */

type NameProfile = { firstName?: string | null; lastName?: string | null };

type DriverInput = {
  id: string;
  userId?: string;
  rating?: unknown;
  totalRides?: unknown;
  profile?: { fullLegalName?: string | null } | null;
  user?: { profile?: NameProfile | null } | null;
};

type CustomerInput = {
  id?: string;
  profile?: NameProfile | null;
};

type VehicleTypeInput = {
  id: string;
  name: string;
  code: string;
};

type VehicleInput = {
  id: string;
  registrationNumber?: string | null;
  color?: string | null;
  make?: string | null;
  model?: string | null;
  vehicleType?: VehicleTypeInput | null;
};

type RideRequestInput = {
  id?: string;
  customerId?: string;
  pickupLat?: unknown;
  pickupLng?: unknown;
  dropLat?: unknown;
  dropLng?: unknown;
  pickupAddress?: string | null;
  dropAddress?: string | null;
  quotedFare?: unknown;
  paymentMethod?: string | null;
  estimatedDistanceKm?: unknown;
  estimatedDurationMin?: number | null;
  vehicleTypeId?: string | null;
};

type RideInput = {
  id: string;
  rideCode?: string | null;
  requestId?: string | null;
  customerId?: string | null;
  driverId?: string | null;
  vehicleId?: string | null;
  vehicleTypeId?: string | null;
  status?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  pickupAddress?: string | null;
  dropAddress?: string | null;
  acceptedAt?: Date | string | null;
  arrivedAt?: Date | string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  fare?: unknown;
  cancellation?: unknown;
  driver?: DriverInput | null;
  customer?: CustomerInput | null;
  vehicle?: VehicleInput | null;
  vehicleType?: VehicleTypeInput | null;
  request?: RideRequestInput | null;
};

type OfferInput = {
  id: string;
  requestId?: string | null;
  driverId?: string | null;
  response?: string | null;
  expiresAt?: Date | string | null;
  driverDistanceM?: number | null;
  driverEtaSeconds?: number | null;
  offeredAt?: Date | string | null;
  request?: RideRequestInput | null;
};

function dec(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function splitLegalName(full: string | null | undefined): {
  firstName: string | null;
  lastName: string | null;
} {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

function nameFromUserProfile(profile?: NameProfile | null): {
  firstName: string | null;
  lastName: string | null;
} {
  return {
    firstName: profile?.firstName ?? null,
    lastName: profile?.lastName ?? null,
  };
}

export function driverDisplayProfile(driver: DriverInput | null | undefined): {
  id: string;
  userId?: string;
  rating: number | null;
  totalTrips: number | null;
  profile: { firstName: string | null; lastName: string | null };
} | null {
  if (!driver) return null;
  const fromLegal = splitLegalName(driver.profile?.fullLegalName);
  const fromUser = nameFromUserProfile(driver.user?.profile);
  const firstName = fromLegal.firstName || fromUser.firstName;
  const lastName = fromLegal.lastName || fromUser.lastName;
  return {
    id: driver.id,
    ...(driver.userId !== undefined ? { userId: driver.userId } : {}),
    rating: dec(driver.rating),
    totalTrips: driver.totalRides != null ? Number(driver.totalRides) : null,
    profile: { firstName, lastName },
  };
}

export function customerDisplayProfile(customer: CustomerInput | null | undefined): {
  id?: string;
  profile: { firstName: string | null; lastName: string | null };
} | null {
  if (!customer) return null;
  return {
    ...(customer.id !== undefined ? { id: customer.id } : {}),
    profile: nameFromUserProfile(customer.profile),
  };
}

/** Shared Prisma include for client-facing ride detail / active ride. */
export const CLIENT_RIDE_INCLUDE = {
  fare: true,
  cancellation: true,
  statusEvents: true,
  driver: {
    select: {
      id: true,
      userId: true,
      rating: true,
      totalRides: true,
      profile: { select: { fullLegalName: true } },
      user: {
        select: {
          profile: { select: { firstName: true, lastName: true } },
        },
      },
    },
  },
  vehicle: {
    select: {
      id: true,
      registrationNumber: true,
      color: true,
      make: true,
      model: true,
      vehicleType: { select: { id: true, name: true, code: true } },
    },
  },
  vehicleType: { select: { id: true, name: true, code: true } },
  customer: {
    select: {
      id: true,
      profile: { select: { firstName: true, lastName: true } },
    },
  },
  request: {
    select: {
      id: true,
      customerId: true,
      pickupLat: true,
      pickupLng: true,
      dropLat: true,
      dropLng: true,
      pickupAddress: true,
      dropAddress: true,
      quotedFare: true,
      paymentMethod: true,
      estimatedDistanceKm: true,
      estimatedDurationMin: true,
      vehicleTypeId: true,
    },
  },
} as const;

export function toClientRideView(
  ride: RideInput | null | undefined,
): Record<string, unknown> | null {
  if (!ride) return null;

  const req = ride.request ?? null;
  const pickupLat = dec(req?.pickupLat);
  const pickupLng = dec(req?.pickupLng);
  const dropLat = dec(req?.dropLat);
  const dropLng = dec(req?.dropLng);
  const driver = driverDisplayProfile(ride.driver);
  const customer = customerDisplayProfile(ride.customer);
  const vehicleType = ride.vehicleType ?? ride.vehicle?.vehicleType ?? null;

  return {
    id: ride.id,
    rideCode: ride.rideCode,
    requestId: ride.requestId,
    customerId: ride.customerId,
    driverId: ride.driverId,
    vehicleId: ride.vehicleId,
    vehicleTypeId: ride.vehicleTypeId,
    status: ride.status,
    paymentMethod: ride.paymentMethod,
    paymentStatus: ride.paymentStatus,
    pickupAddress: ride.pickupAddress ?? req?.pickupAddress ?? null,
    dropAddress: ride.dropAddress ?? req?.dropAddress ?? null,
    pickupLat,
    pickupLng,
    dropLat,
    dropLng,
    acceptedAt: ride.acceptedAt,
    arrivedAt: ride.arrivedAt,
    startedAt: ride.startedAt,
    completedAt: ride.completedAt,
    cancelledAt: ride.cancelledAt,
    fare: ride.fare ?? null,
    cancellation: ride.cancellation ?? null,
    driver,
    customer,
    vehicle: ride.vehicle
      ? {
          id: ride.vehicle.id,
          registrationNumber: ride.vehicle.registrationNumber,
          color: ride.vehicle.color,
          make: ride.vehicle.make,
          model: ride.vehicle.model,
        }
      : null,
    vehicleType: vehicleType
      ? {
          id: vehicleType.id,
          name: vehicleType.name,
          code: vehicleType.code,
        }
      : null,
    request: req
      ? {
          ...req,
          pickupLat,
          pickupLng,
          dropLat,
          dropLng,
          quotedFare: dec(req.quotedFare),
          estimatedDistanceKm: dec(req.estimatedDistanceKm),
          estimatedDurationMin: req.estimatedDurationMin ?? null,
          customer,
        }
      : null,
  };
}

export function toClientOfferView(
  offer: OfferInput,
  customerById: Map<string, { firstName: string | null; lastName: string | null }>,
): Record<string, unknown> {
  const req = offer.request ?? {};
  const customerId = req.customerId;
  const profile = customerId ? customerById.get(customerId) : undefined;
  const customer = customerId
    ? {
        id: customerId,
        profile: {
          firstName: profile?.firstName ?? null,
          lastName: profile?.lastName ?? null,
        },
      }
    : null;

  return {
    id: offer.id,
    requestId: offer.requestId,
    driverId: offer.driverId,
    response: offer.response,
    expiresAt: offer.expiresAt,
    driverDistanceM: offer.driverDistanceM,
    driverEtaSeconds: offer.driverEtaSeconds,
    offeredAt: offer.offeredAt,
    request: {
      id: req.id,
      customerId,
      pickupAddress: req.pickupAddress,
      dropAddress: req.dropAddress,
      pickupLat: dec(req.pickupLat),
      pickupLng: dec(req.pickupLng),
      dropLat: dec(req.dropLat),
      dropLng: dec(req.dropLng),
      quotedFare: dec(req.quotedFare),
      paymentMethod: req.paymentMethod,
      estimatedDistanceKm: dec(req.estimatedDistanceKm),
      estimatedDurationMin: req.estimatedDurationMin,
      vehicleTypeId: req.vehicleTypeId,
      customer,
    },
  };
}
