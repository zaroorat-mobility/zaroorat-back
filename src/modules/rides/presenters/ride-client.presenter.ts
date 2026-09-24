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

type RideStopInput = {
  sequence?: number;
  stopType?: string;
  address?: string | null;
  lat?: unknown;
  lng?: unknown;
};

type RideRequestStopInput = {
  sequence?: number;
  address?: string | null;
  lat?: unknown;
  lng?: unknown;
};

type RideRequestInput = {
  id?: string;
  customerId?: string;
  status?: string | null;
  pickupLat?: unknown;
  pickupLng?: unknown;
  dropLat?: unknown;
  dropLng?: unknown;
  pickupAddress?: string | null;
  dropAddress?: string | null;
  quotedFare?: unknown;
  boostAmount?: unknown;
  paymentMethod?: string | null;
  promoCode?: string | null;
  estimatedDistanceKm?: unknown;
  estimatedDurationMin?: number | null;
  vehicleTypeId?: string | null;
  passengerName?: string | null;
  passengerPhone?: string | null;
  pickupNotes?: string | null;
  scheduledFor?: Date | string | null;
  createdAt?: Date | string | null;
  expiresAt?: Date | string | null;
  vehicleType?: VehicleTypeInput | null;
  stops?: RideRequestStopInput[] | null;
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
  passengerName?: string | null;
  passengerPhone?: string | null;
  pickupNotes?: string | null;
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
  stops?: RideStopInput[] | null;
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
      boostAmount: true,
      paymentMethod: true,
      estimatedDistanceKm: true,
      estimatedDurationMin: true,
      vehicleTypeId: true,
      passengerName: true,
      passengerPhone: true,
      pickupNotes: true,
      stops: {
        select: { sequence: true, lat: true, lng: true, address: true },
        orderBy: { sequence: 'asc' as const },
      },
    },
  },
  stops: {
    select: { sequence: true, stopType: true, address: true },
    orderBy: { sequence: 'asc' as const },
  },
} as const;

function mapStops(stops: RideRequestStopInput[] | RideStopInput[] | null | undefined): Array<{
  sequence: number | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  stopType?: string | null;
}> {
  if (!stops?.length) return [];
  return stops.map((stop) => ({
    sequence: stop.sequence ?? null,
    latitude: dec((stop as RideRequestStopInput).lat),
    longitude: dec((stop as RideRequestStopInput).lng),
    address: stop.address ?? null,
    ...('stopType' in stop ? { stopType: stop.stopType ?? null } : {}),
  }));
}

/** Shared Prisma include for customer-facing pending request reads. */
export const CLIENT_REQUEST_INCLUDE = {
  vehicleType: { select: { id: true, name: true, code: true } },
  stops: {
    select: { sequence: true, lat: true, lng: true, address: true },
    orderBy: { sequence: 'asc' as const },
  },
} as const;

export function toClientRideRequestView(
  request: RideRequestInput | null | undefined,
): Record<string, unknown> | null {
  if (!request?.id) return null;

  const quotedFare = dec(request.quotedFare);
  const boostAmount = dec(request.boostAmount);
  const totalOffered = quotedFare != null ? quotedFare + (boostAmount ?? 0) : null;
  const vehicleType = request.vehicleType ?? null;

  return {
    id: request.id,
    customerId: request.customerId ?? null,
    status: request.status ?? null,
    vehicleTypeId: request.vehicleTypeId ?? null,
    vehicleType: vehicleType
      ? {
          id: vehicleType.id,
          name: vehicleType.name,
          code: vehicleType.code,
        }
      : null,
    pickupLat: dec(request.pickupLat),
    pickupLng: dec(request.pickupLng),
    dropLat: dec(request.dropLat),
    dropLng: dec(request.dropLng),
    pickupAddress: request.pickupAddress ?? null,
    dropAddress: request.dropAddress ?? null,
    quotedFare,
    boostAmount,
    totalOffered,
    paymentMethod: request.paymentMethod ?? null,
    promoCode: request.promoCode ?? null,
    estimatedDistanceKm: dec(request.estimatedDistanceKm),
    estimatedDurationMin: request.estimatedDurationMin ?? null,
    passengerName: request.passengerName ?? null,
    passengerPhone: request.passengerPhone ?? null,
    pickupNotes: request.pickupNotes ?? null,
    stops: mapStops(request.stops),
    createdAt: request.createdAt ?? null,
    expiresAt: request.expiresAt ?? null,
    scheduledFor: request.scheduledFor ?? null,
  };
}

export function toClientRideView(
  ride: RideInput | null | undefined,
): Record<string, unknown> | null {
  if (!ride) return null;

  const req = ride.request ?? null;
  const pickupLat = dec(req?.pickupLat);
  const pickupLng = dec(req?.pickupLng);
  const dropLat = dec(req?.dropLat);
  const dropLng = dec(req?.dropLng);
  const quotedFare = dec(req?.quotedFare);
  const boostAmount = dec(req?.boostAmount);
  const totalOffered = quotedFare != null ? quotedFare + (boostAmount ?? 0) : null;
  const driver = driverDisplayProfile(ride.driver);
  const customer = customerDisplayProfile(ride.customer);
  const vehicleType = ride.vehicleType ?? ride.vehicle?.vehicleType ?? null;
  const stops = mapStops(req?.stops?.length ? req.stops : undefined);

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
    passengerName: ride.passengerName ?? req?.passengerName ?? null,
    passengerPhone: ride.passengerPhone ?? req?.passengerPhone ?? null,
    pickupNotes: ride.pickupNotes ?? req?.pickupNotes ?? null,
    boostAmount,
    totalOffered,
    stops,
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
          quotedFare,
          boostAmount,
          totalOffered,
          estimatedDistanceKm: dec(req.estimatedDistanceKm),
          estimatedDurationMin: req.estimatedDurationMin ?? null,
          passengerName: req.passengerName ?? null,
          passengerPhone: req.passengerPhone ?? null,
          pickupNotes: req.pickupNotes ?? null,
          stops: mapStops(req.stops),
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
  const quotedFare = dec(req.quotedFare);
  const boostAmount = dec(req.boostAmount);
  const totalOffered = quotedFare != null ? quotedFare + (boostAmount ?? 0) : null;

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
      quotedFare,
      boostAmount,
      totalOffered,
      paymentMethod: req.paymentMethod,
      estimatedDistanceKm: dec(req.estimatedDistanceKm),
      estimatedDurationMin: req.estimatedDurationMin,
      vehicleTypeId: req.vehicleTypeId,
      passengerName: req.passengerName ?? null,
      passengerPhone: req.passengerPhone ?? null,
      pickupNotes: req.pickupNotes ?? null,
      stops: mapStops(req.stops),
      customer,
    },
  };
}
