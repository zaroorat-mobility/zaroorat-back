import { DatabaseService } from '@core/database';
import { Prisma } from '../../../../generated/prisma/index.js';
import { ListDispatchRequestsQuery } from './dispatch.schemas.js';
import { RideRequestNotFoundError } from '../operations.errors.js';

export interface AdminDispatchRequestListItemDto {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  vehicleTypeId: string;
  vehicleTypeName: string;
  vehicleTypeCode: string;
  pickupAddress: string;
  pickupLat: number;
  pickupLng: number;
  dropAddress: string | null;
  dropLat: number | null;
  dropLng: number | null;
  estimatedDistanceKm: number | null;
  estimatedDurationMin: number | null;
  quotedFare: number | null;
  surgeMultiplier: number;
  paymentMethod: string | null;
  status: string;
  dispatchRoundsCount: number;
  totalOffersCount: number;
  acceptedDriver: {
    id: string;
    fullName: string;
    phone: string;
  } | null;
  rideId: string | null;
  rideCode: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface AdminDispatchCandidateDto {
  id: string;
  dispatchRound: number;
  driver: {
    id: string;
    driverNumber: string;
    fullName: string;
    phone: string;
    avatarUrl: string | null;
    ratingAvg: number | null;
  };
  vehicle: {
    id: string | null;
    licensePlate: string | null;
    model: string | null;
    make: string | null;
  } | null;
  offeredAt: string;
  respondedAt: string | null;
  response: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'TIMEOUT' | 'CANCELLED';
  rejectReason: string | null;
  driverDistanceM: number | null;
  driverEtaSeconds: number | null;
  expiresAt: string | null;
}

export interface AdminDispatchRequestDetailDto {
  id: string;
  status: string;
  customer: {
    id: string;
    fullName: string;
    phone: string;
    avatarUrl: string | null;
  };
  vehicleType: {
    id: string;
    name: string;
    code: string;
  };
  pickup: {
    address: string;
    lat: number;
    lng: number;
  };
  drop: {
    address: string | null;
    lat: number | null;
    lng: number | null;
  };
  estimatedDistanceKm: number | null;
  estimatedDurationMin: number | null;
  quotedFare: number | null;
  surgeMultiplier: number;
  paymentMethod: string | null;
  promoCode: string | null;
  createdAt: string;
  expiresAt: string | null;
  ride: {
    id: string;
    rideCode: string;
    status: string;
    driver: {
      id: string;
      fullName: string;
      phone: string;
    } | null;
  } | null;
  summary: {
    totalRounds: number;
    totalDispatches: number;
    pendingCount: number;
    acceptedCount: number;
    rejectedCount: number;
    timeoutCount: number;
  };
  candidates: AdminDispatchCandidateDto[];
}

export class AdminDispatchService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async listRequests(query: ListDispatchRequestsQuery): Promise<{
    data: AdminDispatchRequestListItemDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const where: Prisma.RideRequestWhereInput = {};
    if (query.status !== 'all') {
      where.status = query.status;
    }
    if (query.vehicleTypeId) {
      where.vehicleTypeId = query.vehicleTypeId;
    }
    if (query.search) {
      const search = query.search;
      where.OR = [
        { pickupAddress: { contains: search, mode: 'insensitive' } },
        { dropAddress: { contains: search, mode: 'insensitive' } },
      ];
    }

    const total = await this.client.rideRequest.count({ where });
    const page = query.page;
    const limit = query.limit;
    const totalPages = Math.ceil(total / limit) || 1;

    const requests = await this.client.rideRequest.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        vehicleType: true,
        dispatches: {
          include: {
            driver: {
              include: {
                profile: true,
                user: { include: { profile: true } },
              },
            },
          },
        },
        rides: {
          include: {
            driver: {
              include: {
                profile: true,
                user: { include: { profile: true } },
              },
            },
          },
        },
      },
    });

    const customerIds = Array.from(new Set(requests.map((r) => r.customerId)));
    const customers =
      customerIds.length > 0
        ? await this.client.user.findMany({
            where: { id: { in: customerIds } },
            include: { profile: true },
          })
        : [];
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    const data: AdminDispatchRequestListItemDto[] = requests.map((req) => {
      const matchedRide = req.rides?.[0] ?? null;
      const acceptedDispatch = req.dispatches.find((d) => d.response === 'ACCEPTED');
      const driverObj = matchedRide?.driver ?? acceptedDispatch?.driver ?? null;

      const driverName = driverObj?.user?.profile
        ? [driverObj.user.profile.firstName, driverObj.user.profile.lastName]
            .filter(Boolean)
            .join(' ')
        : (driverObj?.profile?.fullLegalName ?? 'Driver');
      const driverPhone = driverObj?.user?.phoneNumber ?? '';

      const acceptedDriver = driverObj
        ? {
            id: driverObj.id,
            fullName: driverName,
            phone: driverPhone,
          }
        : null;

      const rounds = new Set(req.dispatches.map((d) => d.dispatchRound));
      const customer = customerMap.get(req.customerId);
      const customerName =
        [customer?.profile?.firstName, customer?.profile?.lastName].filter(Boolean).join(' ') ||
        'Customer';

      return {
        id: req.id,
        customerId: req.customerId,
        customerName,
        customerPhone: customer?.phoneNumber ?? '',
        vehicleTypeId: req.vehicleTypeId,
        vehicleTypeName: req.vehicleType.name,
        vehicleTypeCode: req.vehicleType.code,
        pickupAddress: req.pickupAddress ?? '',
        pickupLat: Number(req.pickupLat),
        pickupLng: Number(req.pickupLng),
        dropAddress: req.dropAddress ?? null,
        dropLat: req.dropLat ? Number(req.dropLat) : null,
        dropLng: req.dropLng ? Number(req.dropLng) : null,
        estimatedDistanceKm: req.estimatedDistanceKm ? Number(req.estimatedDistanceKm) : null,
        estimatedDurationMin: req.estimatedDurationMin ?? null,
        quotedFare: req.quotedFare ? Number(req.quotedFare) : null,
        surgeMultiplier: Number(req.surgeMultiplier),
        paymentMethod: req.paymentMethod ?? null,
        status: req.status,
        dispatchRoundsCount: rounds.size || (req.dispatches.length > 0 ? 1 : 0),
        totalOffersCount: req.dispatches.length,
        acceptedDriver,
        rideId: matchedRide?.id ?? req.rideId ?? null,
        rideCode: matchedRide?.rideCode ?? null,
        createdAt: req.createdAt.toISOString(),
        expiresAt: req.expiresAt ? req.expiresAt.toISOString() : null,
      };
    });

    return { data, meta: { page, limit, total, totalPages } };
  }

  async getRequestDetails(requestId: string): Promise<AdminDispatchRequestDetailDto> {
    const req = await this.client.rideRequest.findUnique({
      where: { id: requestId },
      include: {
        vehicleType: true,
        dispatches: {
          orderBy: [{ dispatchRound: 'asc' }, { offeredAt: 'asc' }],
          include: {
            driver: {
              include: {
                profile: true,
                user: { include: { profile: true } },
                ratingAggregate: true,
              },
            },
            vehicle: true,
          },
        },
        rides: {
          include: {
            driver: {
              include: {
                profile: true,
                user: { include: { profile: true } },
              },
            },
          },
        },
      },
    });

    if (!req) {
      throw new RideRequestNotFoundError(`Ride request ${requestId} was not found`);
    }

    const customer = await this.client.user.findUnique({
      where: { id: req.customerId },
      include: { profile: true },
    });

    const customerName =
      [customer?.profile?.firstName, customer?.profile?.lastName].filter(Boolean).join(' ') ||
      'Customer';

    const matchedRide = req.rides?.[0] ?? null;

    let pendingCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let timeoutCount = 0;
    const rounds = new Set<number>();

    const candidates: AdminDispatchCandidateDto[] = req.dispatches.map((d) => {
      rounds.add(d.dispatchRound);
      if (d.response === 'PENDING') pendingCount++;
      else if (d.response === 'ACCEPTED') acceptedCount++;
      else if (d.response === 'REJECTED') rejectedCount++;
      else if (d.response === 'TIMEOUT') timeoutCount++;

      const driverName = d.driver.user?.profile
        ? [d.driver.user.profile.firstName, d.driver.user.profile.lastName]
            .filter(Boolean)
            .join(' ')
        : (d.driver.profile?.fullLegalName ?? 'Driver');
      const driverPhone = d.driver.user?.phoneNumber ?? '';
      const avatar =
        d.driver.user?.profile?.profileImageFileId ?? d.driver.profile?.profilePhoto ?? null;

      return {
        id: d.id,
        dispatchRound: d.dispatchRound,
        driver: {
          id: d.driver.id,
          driverNumber: d.driver.driverCode,
          fullName: driverName,
          phone: driverPhone,
          avatarUrl: avatar,
          ratingAvg: d.driver.ratingAggregate?.avgRating
            ? Number(d.driver.ratingAggregate.avgRating)
            : null,
        },
        vehicle: d.vehicle
          ? {
              id: d.vehicle.id,
              licensePlate: d.vehicle.registrationNumber,
              model: d.vehicle.model,
              make: d.vehicle.make,
            }
          : null,
        offeredAt: d.offeredAt.toISOString(),
        respondedAt: d.respondedAt ? d.respondedAt.toISOString() : null,
        response: d.response,
        rejectReason: d.rejectReason ?? null,
        driverDistanceM: d.driverDistanceM ?? null,
        driverEtaSeconds: d.driverEtaSeconds ?? null,
        expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
      };
    });

    const matchedDriverName = matchedRide?.driver?.user?.profile
      ? [matchedRide.driver.user.profile.firstName, matchedRide.driver.user.profile.lastName]
          .filter(Boolean)
          .join(' ')
      : (matchedRide?.driver?.profile?.fullLegalName ?? 'Driver');

    const matchedDriver = matchedRide?.driver
      ? {
          id: matchedRide.driver.id,
          fullName: matchedDriverName || 'Driver',
          phone: matchedRide.driver.user?.phoneNumber ?? '',
        }
      : null;

    return {
      id: req.id,
      status: req.status,
      customer: {
        id: req.customerId,
        fullName: customerName,
        phone: customer?.phoneNumber ?? '',
        avatarUrl: null,
      },
      vehicleType: {
        id: req.vehicleType.id,
        name: req.vehicleType.name,
        code: req.vehicleType.code,
      },
      pickup: {
        address: req.pickupAddress ?? '',
        lat: Number(req.pickupLat),
        lng: Number(req.pickupLng),
      },
      drop: {
        address: req.dropAddress ?? null,
        lat: req.dropLat ? Number(req.dropLat) : null,
        lng: req.dropLng ? Number(req.dropLng) : null,
      },
      estimatedDistanceKm: req.estimatedDistanceKm ? Number(req.estimatedDistanceKm) : null,
      estimatedDurationMin: req.estimatedDurationMin ?? null,
      quotedFare: req.quotedFare ? Number(req.quotedFare) : null,
      surgeMultiplier: Number(req.surgeMultiplier),
      paymentMethod: req.paymentMethod ?? null,
      promoCode: req.promoCode ?? null,
      createdAt: req.createdAt.toISOString(),
      expiresAt: req.expiresAt ? req.expiresAt.toISOString() : null,
      ride: matchedRide
        ? {
            id: matchedRide.id,
            rideCode: matchedRide.rideCode,
            status: matchedRide.status,
            driver: matchedDriver,
          }
        : null,
      summary: {
        totalRounds: rounds.size,
        totalDispatches: req.dispatches.length,
        pendingCount,
        acceptedCount,
        rejectedCount,
        timeoutCount,
      },
      candidates,
    };
  }

  async getCandidates(requestId: string): Promise<{
    requestId: string;
    total: number;
    candidates: AdminDispatchCandidateDto[];
  }> {
    const details = await this.getRequestDetails(requestId);
    return {
      requestId: details.id,
      total: details.candidates.length,
      candidates: details.candidates,
    };
  }
}
