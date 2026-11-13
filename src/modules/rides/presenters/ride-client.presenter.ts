import { decodeEncodedPolyline } from '@shared/geo/polyline.util.js';
import type { RideEtaSnapshot } from '@modules/location/services/ride-eta.service.js';
import type { FileRepository } from '@modules/files/repositories/file.repository.js';
import type { FileStorageService } from '@modules/files/services/file-storage.service.js';
import { logger } from '@shared/logger/index.js';
/**
 * Shapes Prisma ride / offer rows for customer + driver mobile clients.
 * Backend never returns the Ride PIN plaintext — only party/vehicle details.
 */

const FILE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVER_PHOTO_TTL_SECONDS = 3600;

export interface ClientRideMedia {
  driverProfileImageUrl?: string | null;
  vehicleTypeImageUrl?: string | null;
  vehicleTypeIconUrl?: string | null;
}

export interface RideMediaDependencies {
  fileRepository?: FileRepository | undefined;
  fileStorageService?: FileStorageService | undefined;
}

type NameProfile = { firstName?: string | null; lastName?: string | null };

type DriverInput = {
  id: string;
  userId?: string;
  rating?: unknown;
  totalRides?: unknown;
  approvedAt?: Date | string | null;
  createdAt?: Date | string | null;
  profile?: { fullLegalName?: string | null; profilePhoto?: string | null } | null;
  user?: { profile?: (NameProfile & { profileImageFileId?: string | null }) | null } | null;
};

type CustomerInput = {
  id?: string;
  profile?: NameProfile | null;
  customerRatingAggregate?: { avgRating?: unknown; totalRatings?: number | null | undefined } | null;
};

type VehicleTypeInput = {
  id: string;
  name: string;
  code: string;
  icon?: string | null;
  imageUrl?: string | null;
  imageFileId?: string | null;
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
  pricingRule?: { freeWaitingMin?: number | null; waitingPerMin?: unknown } | null;
};

type FareInput = {
  id?: string;
  rideId?: string;
  baseFare?: unknown;
  distanceFare?: unknown;
  timeFare?: unknown;
  waitingFare?: unknown;
  waitingCharge?: unknown;
  surgeAmount?: unknown;
  discountAmount?: unknown;
  platformFee?: unknown;
  platformCommission?: unknown;
  cgst?: unknown;
  sgst?: unknown;
  igst?: unknown;
  taxAmount?: unknown;
  tipAmount?: unknown;
  tollAmount?: unknown;
  totalFare?: unknown;
  driverEarning?: unknown;
  driverEarnings?: unknown;
  currency?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type CancellationInput = {
  id?: string;
  cancelledBy?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  cancellationFee?: unknown;
  feeCharged?: boolean | null;
  createdAt?: Date | string | null;
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
  createdAt?: Date | string | null;
  acceptedAt?: Date | string | null;
  arrivedAt?: Date | string | null;
  dropoffArrivedAt?: Date | string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  actualDistanceKm?: unknown;
  actualDurationMin?: number | null;
  driverPaymentModel?: string | null;
  commissionAmount?: unknown;
  fare?: unknown;
  cancellation?: CancellationInput | null;
  driver?: DriverInput | null;
  customer?: CustomerInput | null;
  vehicle?: VehicleInput | null;
  vehicleType?: VehicleTypeInput | null;
  request?: RideRequestInput | null;
  stops?: RideStopInput[] | null;
  statusEvents?: Array<{
    id?: string;
    fromStatus?: string | null;
    toStatus?: string;
    actorType?: string | null;
    actorId?: string | null;
    reason?: string | null;
    createdAt?: Date | string;
  }> | null;
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

export const VEHICLE_TYPE_CLIENT_SELECT = {
  id: true,
  name: true,
  code: true,
  icon: true,
  imageUrl: true,
  imageFileId: true,
} as const;

function isPresignedS3Url(url: string): boolean {
  return url.includes('X-Amz-Signature=') || url.includes('X-Amz-Date=');
}

/** Filters out stale S3 presigned URLs or broken non-UUID image paths. */
export function resolveSafeClientImageUrl(raw: string | null | undefined): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (value.startsWith('/api/v1/vehicle-types/images/')) {
    const fileId = value.slice('/api/v1/vehicle-types/images/'.length).split('?')[0] ?? '';
    return FILE_UUID_RE.test(fileId) ? value : null;
  }
  if (value.startsWith('/api/')) return value;
  if (/^https?:\/\//i.test(value) && !isPresignedS3Url(value)) {
    return value;
  }
  return null;
}

export function extractDriverPhotoRef(driver: DriverInput | null | undefined): string | null {
  const fromDriverProfile =
    typeof driver?.profile?.profilePhoto === 'string' ? driver.profile.profilePhoto.trim() : '';
  if (fromDriverProfile) return fromDriverProfile;
  const fromUserProfile =
    typeof driver?.user?.profile?.profileImageFileId === 'string'
      ? driver.user.profile.profileImageFileId.trim()
      : '';
  return fromUserProfile || null;
}

export function resolveVehicleTypeImageUrl(vt: VehicleTypeInput | null | undefined): string | null {
  const fileId = typeof vt?.imageFileId === 'string' ? vt.imageFileId.trim() : '';
  if (fileId && FILE_UUID_RE.test(fileId)) {
    return `/api/v1/vehicle-types/images/${fileId}`;
  }
  return resolveSafeClientImageUrl(vt?.imageUrl);
}

function presentVehicleType(
  vt: VehicleTypeInput | null | undefined,
  media?: ClientRideMedia | null,
): Record<string, unknown> | null {
  if (!vt) return null;
  return {
    id: vt.id,
    name: vt.name,
    code: vt.code,
    imageFileId: vt.imageFileId ?? null,
    imageUrl: media?.vehicleTypeImageUrl ?? resolveVehicleTypeImageUrl(vt),
    icon: media?.vehicleTypeIconUrl ?? resolveSafeClientImageUrl(vt.icon),
  };
}

export function driverDisplayProfile(
  driver: DriverInput | null | undefined,
  resolvedProfileImageUrl?: string | null,
): {
  id: string;
  userId?: string;
  rating: number | null;
  totalTrips: number | null;
  monthsActive?: number;
  profileImageUrl: string | null;
  profile: {
    firstName: string | null;
    lastName: string | null;
    profileImageUrl?: string | null;
  };
} | null {
  if (!driver) return null;
  const fromLegal = splitLegalName(driver.profile?.fullLegalName);
  const fromUser = nameFromUserProfile(driver.user?.profile);
  const firstName = fromLegal.firstName || fromUser.firstName;
  const lastName = fromLegal.lastName || fromUser.lastName;
  const profileImageUrl =
    resolvedProfileImageUrl ?? resolveSafeClientImageUrl(extractDriverPhotoRef(driver));
  const sinceRaw = driver.approvedAt ?? driver.createdAt;
  let monthsActive: number | undefined;
  if (sinceRaw != null) {
    const sinceMs = new Date(sinceRaw).getTime();
    if (Number.isFinite(sinceMs)) {
      monthsActive = Math.max(
        1,
        Math.floor((Date.now() - sinceMs) / (1000 * 60 * 60 * 24 * 30.44)),
      );
    }
  }
  return {
    id: driver.id,
    ...(driver.userId !== undefined ? { userId: driver.userId } : {}),
    rating: dec(driver.rating),
    totalTrips: driver.totalRides != null ? Number(driver.totalRides) : null,
    ...(monthsActive !== undefined ? { monthsActive } : {}),
    profileImageUrl,
    profile: {
      firstName,
      lastName,
      ...(profileImageUrl ? { profileImageUrl } : {}),
    },
  };
}

export function customerDisplayProfile(customer: CustomerInput | null | undefined): {
  id?: string;
  profile: { firstName: string | null; lastName: string | null };
  rating: number | null;
  totalRatings: number;
} | null {
  if (!customer) return null;
  return {
    ...(customer.id !== undefined ? { id: customer.id } : {}),
    profile: nameFromUserProfile(customer.profile),
    ...riderRating(customer.customerRatingAggregate),
  };
}

/// The aggregate row's average is 0 until a first rating exists: that is "new
/// rider", not a rider rated zero.
function riderRating(aggregate: CustomerInput['customerRatingAggregate']): {
  rating: number | null;
  totalRatings: number;
} {
  const totalRatings = aggregate?.totalRatings ?? 0;
  return { rating: totalRatings > 0 ? dec(aggregate?.avgRating) : null, totalRatings };
}

/// What this offer should leave the driver with, on the same split the ledger
/// applies at completion: a SUBSCRIPTION driver pays no per-ride commission, so
/// that part of the fare stays theirs; a COMMISSION driver pays it from the wallet.
export function estimatedDriverEarning(
  quote: { driverEarning: number; platformCommission: number },
  boostAmount: number,
  paymentModel: string | null | undefined,
): number {
  const earning =
    quote.driverEarning +
    boostAmount +
    (paymentModel === 'SUBSCRIPTION' ? quote.platformCommission : 0);
  return Math.round(earning * 100) / 100;
}

/** Shared Prisma include for client-facing ride detail / active ride. */
export const CLIENT_RIDE_INCLUDE = {
  fare: true,
  cancellation: true,
  statusEvents: true,
  routePlan: {
    select: {
      encodedPolyline: true,
      plannedDistanceKm: true,
      plannedDurationMin: true,
    },
  },
  driver: {
    select: {
      id: true,
      userId: true,
      rating: true,
      totalRides: true,
      approvedAt: true,
      createdAt: true,
      profile: { select: { fullLegalName: true, profilePhoto: true } },
      user: {
        select: {
          profile: { select: { firstName: true, lastName: true, profileImageFileId: true } },
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
      vehicleType: { select: VEHICLE_TYPE_CLIENT_SELECT },
    },
  },
  vehicleType: { select: VEHICLE_TYPE_CLIENT_SELECT },
  customer: {
    select: {
      id: true,
      profile: { select: { firstName: true, lastName: true } },
      customerRatingAggregate: { select: { avgRating: true, totalRatings: true } },
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
      pricingRule: { select: { freeWaitingMin: true, waitingPerMin: true } },
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
  vehicleType: { select: VEHICLE_TYPE_CLIENT_SELECT },
  stops: {
    select: { sequence: true, lat: true, lng: true, address: true },
    orderBy: { sequence: 'asc' as const },
  },
} as const;

export function toClientRideRequestView(
  request: RideRequestInput | null | undefined,
  offerStats?: {
    offersSent?: number;
    offersRejected?: number;
    driversNotified?: number;
    driversRejected?: number;
  } | null,
): Record<string, unknown> | null {
  if (!request?.id) return null;

  const quotedFare = dec(request.quotedFare);
  const boostAmount = dec(request.boostAmount) ?? 0;
  const totalOffered = quotedFare != null ? quotedFare + boostAmount : null;
  const vehicleType = request.vehicleType ?? null;

  return {
    id: request.id,
    customerId: request.customerId ?? null,
    status: request.status ?? null,
    vehicleTypeId: request.vehicleTypeId ?? null,
    vehicleType: presentVehicleType(vehicleType),
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
    ...((offerStats?.driversNotified ?? offerStats?.offersSent) != null
      ? {
          driversNotified: offerStats?.driversNotified ?? offerStats?.offersSent,
          offersSent: offerStats?.offersSent ?? offerStats?.driversNotified,
        }
      : {}),
    ...((offerStats?.driversRejected ?? offerStats?.offersRejected) != null
      ? {
          driversRejected: offerStats?.driversRejected ?? offerStats?.offersRejected,
          offersRejected: offerStats?.offersRejected ?? offerStats?.driversRejected,
        }
      : {}),
  };
}

export function toClientRideView(
  ride: RideInput | null | undefined,
  eta?: RideEtaSnapshot | null,
  media?: ClientRideMedia | null,
): Record<string, unknown> | null {
  if (!ride) return null;

  const req = ride.request ?? null;
  const pickupLat = dec(req?.pickupLat);
  const pickupLng = dec(req?.pickupLng);
  const dropLat = dec(req?.dropLat);
  const dropLng = dec(req?.dropLng);
  const quotedFare = dec(req?.quotedFare);
  const boostAmount = dec(req?.boostAmount) ?? 0;
  const totalOffered = quotedFare != null ? quotedFare + boostAmount : null;
  const driver = driverDisplayProfile(ride.driver, media?.driverProfileImageUrl);
  const customer = customerDisplayProfile(ride.customer);
  const vehicleType = ride.vehicleType ?? ride.vehicle?.vehicleType ?? null;
  const stops = mapStops(req?.stops?.length ? req.stops : undefined);

  const routePlan =
    (ride as { routePlan?: { encodedPolyline?: string | null } | null }).routePlan ?? null;
  const encodedPolyline = routePlan?.encodedPolyline ?? null;
  let routePath: Array<{ latitude: number; longitude: number }> | null = null;
  if (encodedPolyline) {
    try {
      const decoded = decodeEncodedPolyline(encodedPolyline);
      routePath = decoded.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
    } catch {
      routePath = null;
    }
  }

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
    quotedFare,
    boostAmount,
    totalOffered,
    encodedPolyline,
    routePath,
    routeAvailable: routePath != null && routePath.length > 0,
    eta: eta
      ? {
          destinationType: eta.destinationType,
          remainingDistanceMeters: eta.remainingDistanceMeters,
          remainingDurationSeconds: eta.remainingDurationSeconds,
          providerName: eta.providerName,
          stale: eta.stale,
          computedAt: eta.computedAt,
        }
      : null,
    stops,
    // The booked rule's waiting terms, so the apps show what completion will bill.
    waitingPolicy: req?.pricingRule
      ? {
          freeMinutes: req.pricingRule.freeWaitingMin ?? 0,
          perMinute: dec(req.pricingRule.waitingPerMin) ?? 0,
        }
      : null,
    timeline: ride.statusEvents
      ? ride.statusEvents.map((e) => ({
          id: e.id,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          actorType: e.actorType,
          reason: e.reason,
          createdAt: e.createdAt,
        }))
      : undefined,
    createdAt: ride.createdAt ?? null,
    acceptedAt: ride.acceptedAt,
    arrivedAt: ride.arrivedAt,
    dropoffArrivedAt: ride.dropoffArrivedAt ?? null,
    startedAt: ride.startedAt,
    completedAt: ride.completedAt,
    cancelledAt: ride.cancelledAt,
    actualDistanceKm: dec(ride.actualDistanceKm),
    actualDurationMin: ride.actualDurationMin ?? null,
    distanceKm: dec(ride.actualDistanceKm) ?? dec(req?.estimatedDistanceKm) ?? null,
    durationMin: ride.actualDurationMin ?? req?.estimatedDurationMin ?? null,
    driverPaymentModel: ride.driverPaymentModel ?? null,
    commissionAmount: dec(ride.commissionAmount),
    fare: ride.fare
      ? (() => {
          const f = ride.fare as FareInput;
          const driverEarning = dec(f.driverEarning ?? f.driverEarnings);
          const platformCommission = dec(f.platformCommission ?? f.platformFee);
          const waitingCharge = dec(f.waitingCharge ?? f.waitingFare);
          const taxAmount = dec(
            f.taxAmount ?? ((dec(f.cgst) ?? 0) + (dec(f.sgst) ?? 0) + (dec(f.igst) ?? 0) || null),
          );
          return {
            ...(f as Record<string, unknown>),
            baseFare: dec(f.baseFare),
            distanceFare: dec(f.distanceFare),
            timeFare: dec(f.timeFare),
            waitingFare: waitingCharge,
            waitingCharge,
            surgeAmount: dec(f.surgeAmount),
            discountAmount: dec(f.discountAmount),
            platformFee: platformCommission,
            platformCommission,
            taxAmount,
            cgst: dec(f.cgst),
            sgst: dec(f.sgst),
            igst: dec(f.igst),
            tipAmount: dec(f.tipAmount),
            tollAmount: dec(f.tollAmount),
            totalFare: dec(f.totalFare),
            driverEarning,
            driverEarnings: driverEarning,
          };
        })()
      : null,
    cancellation: ride.cancellation
      ? {
          id: ride.cancellation.id,
          cancelledBy: ride.cancellation.cancelledBy,
          reasonCode: ride.cancellation.reasonCode,
          reasonText: ride.cancellation.reasonText ?? null,
          cancellationFee: dec(ride.cancellation.cancellationFee),
          feeCharged: Boolean(ride.cancellation.feeCharged),
          createdAt: ride.cancellation.createdAt,
        }
      : null,
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
    vehicleType: presentVehicleType(vehicleType, media),
    request: req
      ? {
          ...req,
          // Exposed once, normalised, as `waitingPolicy`.
          pricingRule: undefined,
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

/**
 * Resolves ride-party-scoped media (signing stored driver profile photo file IDs
 * when file dependencies are injected) and returns the client ride view.
 */
export async function toClientRideViewWithMedia(
  ride: RideInput | null | undefined,
  eta?: RideEtaSnapshot | null,
  deps?: RideMediaDependencies,
): Promise<Record<string, unknown> | null> {
  if (!ride) return null;

  let driverProfileImageUrl: string | null = null;
  const photoRef = extractDriverPhotoRef(ride.driver);
  if (photoRef) {
    if (FILE_UUID_RE.test(photoRef) && deps?.fileRepository && deps?.fileStorageService) {
      try {
        const file = await deps.fileRepository.findReadable(photoRef);
        if (file?.storageKey) {
          const signed = await deps.fileStorageService.signDownload({
            key: file.storageKey,
            ttlSeconds: DRIVER_PHOTO_TTL_SECONDS,
            contentType: file.contentType || 'image/jpeg',
            disposition: 'inline',
            fileName: file.fileName || 'driver-profile.jpg',
          });
          driverProfileImageUrl = signed.url;
        }
      } catch (err) {
        logger.warn({ err, rideId: ride.id }, '[rides] failed to sign driver profile photo');
      }
    } else {
      driverProfileImageUrl = resolveSafeClientImageUrl(photoRef);
    }
  }

  return toClientRideView(ride, eta, { driverProfileImageUrl });
}

/** Shape a RideRequest row for the customer app (active search / resume). */
export function toClientRequestView(
  req:
    | (RideRequestInput & {
        id: string;
        status?: string | null;
        createdAt?: Date | string | null;
        expiresAt?: Date | string | null;
        scheduledFor?: Date | string | null;
      })
    | null
    | undefined,
  offerStats?: {
    offersSent?: number;
    offersRejected?: number;
    driversNotified?: number;
    driversRejected?: number;
  } | null,
): Record<string, unknown> | null {
  if (!req?.id) return null;
  const quoted = dec(req.quotedFare);
  const boost = dec(req.boostAmount) ?? 0;
  const notified = offerStats?.driversNotified ?? offerStats?.offersSent;
  const rejected = offerStats?.driversRejected ?? offerStats?.offersRejected;
  return {
    id: req.id,
    customerId: req.customerId ?? null,
    status: req.status ?? null,
    vehicleTypeId: req.vehicleTypeId ?? null,
    pickupLat: dec(req.pickupLat),
    pickupLng: dec(req.pickupLng),
    dropLat: dec(req.dropLat),
    dropLng: dec(req.dropLng),
    pickupAddress: req.pickupAddress ?? null,
    dropAddress: req.dropAddress ?? null,
    quotedFare: quoted,
    boostAmount: boost,
    totalOffered: quoted != null ? quoted + boost : null,
    paymentMethod: req.paymentMethod ?? null,
    estimatedDistanceKm: dec(req.estimatedDistanceKm),
    estimatedDurationMin: req.estimatedDurationMin ?? null,
    createdAt: req.createdAt ?? null,
    expiresAt: req.expiresAt ?? null,
    scheduledFor: req.scheduledFor ?? null,
    ...(notified != null
      ? {
          driversNotified: notified,
          offersSent: notified,
        }
      : {}),
    ...(rejected != null
      ? {
          driversRejected: rejected,
          offersRejected: rejected,
        }
      : {}),
  };
}

export function toClientOfferView(
  offer: OfferInput,
  customerById: Map<
    string,
    {
      firstName: string | null;
      lastName: string | null;
      avgRating?: unknown;
      totalRatings?: number | null | undefined;
    }
  >,
  estimatedEarning: number | null = null,
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
        ...riderRating(profile),
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
    estimatedDriverEarning: estimatedEarning,
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
