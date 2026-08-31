import { DatabaseService } from '@core/database';
import {
  Prisma,
  type PaymentMethod,
  type PaymentStatus,
} from '../../../../generated/prisma/index.js';
import { recordAdminAction } from '../../audit/index.js';
import { LifecycleService } from '../../../rides/services/lifecycle/lifecycle.service.js';
import { RideNotFoundError } from '../operations.errors.js';
import type { MapProviderService } from '@modules/location/business-services/map-provider.service.js';
import { RoutingProviderUnavailableError } from '@modules/location/errors/location.errors.js';
import { coordinatesToLatLngPath, decodeEncodedPolyline } from '@shared/geo/polyline.util.js';
import type { PrismaTx } from '../operations.types.js';
import type {
  AddRideNoteBody,
  CancelRideBody,
  ExportAdminRidesQuery,
  ListAdminRidesQuery,
  ListRideAuditLogsQuery,
} from './ride.schemas.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RideMapSource = {
  id: string;
  rideCode: string;
  requestId: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  pickupAddress: string | null;
  dropAddress: string | null;
  isScheduled: boolean;
  actualDistanceKm: Prisma.Decimal | null;
  actualDurationMin: number | null;
  customer: {
    id: string;
    phoneNumber: string;
    email: string | null;
    profile?: { firstName: string | null; lastName: string | null } | null;
    customerRatingAggregate?: { avgRating: Prisma.Decimal | null } | null;
  };
  driver?: {
    id: string;
    driverCode: string;
    rating: Prisma.Decimal | null;
    user?: {
      phoneNumber: string;
      profile?: { firstName: string | null; lastName: string | null } | null;
    } | null;
    profile?: { fullLegalName: string | null } | null;
  } | null;
  vehicle?: {
    id: string;
    registrationNumber: string;
    make: string | null;
    model: string | null;
    color: string | null;
    vehicleType: { id: string; name: string; code: string };
  } | null;
  request?: {
    quotedFare: Prisma.Decimal | null;
    estimatedDistanceKm: Prisma.Decimal | null;
    estimatedDurationMin: number | null;
    scheduledFor: Date | null;
    pickupLat: Prisma.Decimal | null;
    pickupLng: Prisma.Decimal | null;
    dropLat: Prisma.Decimal | null;
    dropLng: Prisma.Decimal | null;
  } | null;
  fare?: { totalFare?: Prisma.Decimal | null } | null;
};

export interface AdminRideListItemDto {
  id: string;
  rideCode: string;
  requestId: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  bookingTime: string;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  pickupAddress: string | null;
  dropAddress: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropLat: number | null;
  dropLng: number | null;
  distanceKm: number | null;
  durationMin: number | null;
  quotedFare: number | null;
  finalFare: number | null;
  isScheduled: boolean;
  scheduledFor: string | null;
  customer: {
    id: string;
    name: string;
    phoneNumber: string;
    email: string | null;
    ratingAvg: number | null;
  };
  driver: {
    id: string;
    name: string;
    phoneNumber: string;
    driverCode: string;
    rating: number | null;
  } | null;
  vehicle: {
    id: string;
    plateNumber: string;
    make: string | null;
    model: string | null;
    color: string | null;
    vehicleType: {
      id: string;
      name: string;
      code: string;
    };
  } | null;
  createdAt: string;
  updatedAt: string;
}

export class AdminRideService {
  constructor(
    private readonly db: DatabaseService,
    private readonly lifecycleService: LifecycleService,
    private readonly mapProviderService?: MapProviderService,
  ) {}

  private get client() {
    return this.db.client;
  }

  async list(query: ListAdminRidesQuery): Promise<{
    data: AdminRideListItemDto[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const {
      page,
      limit,
      search,
      status,
      paymentStatus,
      paymentMethod,
      vehicleTypeId,
      customerId,
      driverId,
      from,
      to,
    } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.RideWhereInput = {};

    if (status && status !== 'all') {
      where.status = status;
    }

    if (paymentStatus && paymentStatus !== 'all') {
      where.paymentStatus = paymentStatus as PaymentStatus;
    }

    if (paymentMethod && paymentMethod !== 'all') {
      where.paymentMethod = paymentMethod as PaymentMethod;
    }

    if (vehicleTypeId) {
      where.vehicleTypeId = vehicleTypeId;
    }

    if (customerId) {
      where.customerId = customerId;
    }

    if (driverId) {
      where.driverId = driverId;
    }

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    if (search) {
      where.OR = [
        { rideCode: { contains: search, mode: 'insensitive' } },
        { pickupAddress: { contains: search, mode: 'insensitive' } },
        { dropAddress: { contains: search, mode: 'insensitive' } },
        { customer: { phoneNumber: { contains: search, mode: 'insensitive' } } },
        { customer: { profile: { firstName: { contains: search, mode: 'insensitive' } } } },
        { customer: { profile: { lastName: { contains: search, mode: 'insensitive' } } } },
        { driver: { user: { phoneNumber: { contains: search, mode: 'insensitive' } } } },
        { driver: { profile: { fullLegalName: { contains: search, mode: 'insensitive' } } } },
        { vehicle: { registrationNumber: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, rides] = await Promise.all([
      this.client.ride.count({ where }),
      this.client.ride.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: {
              id: true,
              phoneNumber: true,
              email: true,
              profile: {
                select: {
                  firstName: true,
                  lastName: true,
                },
              },
              customerRatingAggregate: {
                select: {
                  avgRating: true,
                },
              },
            },
          },
          driver: {
            select: {
              id: true,
              driverCode: true,
              rating: true,
              user: {
                select: {
                  id: true,
                  phoneNumber: true,
                  email: true,
                  profile: {
                    select: {
                      firstName: true,
                      lastName: true,
                    },
                  },
                },
              },
              profile: {
                select: {
                  fullLegalName: true,
                },
              },
            },
          },
          vehicle: {
            select: {
              id: true,
              registrationNumber: true,
              make: true,
              model: true,
              color: true,
              vehicleType: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                },
              },
            },
          },
          vehicleType: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          request: {
            select: {
              id: true,
              pickupLat: true,
              pickupLng: true,
              dropLat: true,
              dropLng: true,
              quotedFare: true,
              estimatedDistanceKm: true,
              estimatedDurationMin: true,
              scheduledFor: true,
            },
          },
          fare: {
            select: {
              totalFare: true,
            },
          },
        },
      }),
    ]);

    const data: AdminRideListItemDto[] = rides.map((ride) => this.mapToListItemDto(ride));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async getById(idOrCode: string) {
    const isUuid = UUID_REGEX.test(idOrCode);
    const ride = await this.client.ride.findFirst({
      where: isUuid ? { OR: [{ id: idOrCode }, { rideCode: idOrCode }] } : { rideCode: idOrCode },
      include: {
        customer: {
          select: {
            id: true,
            phoneNumber: true,
            email: true,
            profile: {
              select: {
                firstName: true,
                lastName: true,
                gender: true,
              },
            },
            customerRatingAggregate: {
              select: {
                avgRating: true,
                totalRatings: true,
              },
            },
          },
        },
        driver: {
          select: {
            id: true,
            driverCode: true,
            rating: true,
            totalRides: true,
            user: {
              select: {
                id: true,
                phoneNumber: true,
                email: true,
                profile: {
                  select: {
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
            profile: {
              select: {
                fullLegalName: true,
              },
            },
          },
        },
        vehicle: {
          select: {
            id: true,
            registrationNumber: true,
            make: true,
            model: true,
            color: true,
            manufacturingYear: true,
            fuelType: true,
            vehicleType: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
        vehicleType: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        request: {
          select: {
            id: true,
            pickupLat: true,
            pickupLng: true,
            dropLat: true,
            dropLng: true,
            quotedFare: true,
            surgeMultiplier: true,
            estimatedDistanceKm: true,
            estimatedDurationMin: true,
            scheduledFor: true,
            promoCode: true,
          },
        },
        fare: true,
        fareLines: {
          orderBy: { sequence: 'asc' },
        },
        cancellation: true,
        otps: {
          select: {
            id: true,
            purpose: true,
            verified: true,
            verifiedAt: true,
            attempts: true,
            expiresAt: true,
            createdAt: true,
          },
        },
        receipt: true,
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        ratings: {
          orderBy: { createdAt: 'desc' },
        },
        disputes: {
          orderBy: { createdAt: 'desc' },
        },
        stops: {
          orderBy: { sequence: 'asc' },
        },
        statusEvents: {
          orderBy: { createdAt: 'asc' },
        },
        promosApplied: true,
        opsNotes: {
          orderBy: { createdAt: 'desc' },
          include: {
            author: {
              select: {
                id: true,
                phoneNumber: true,
                profile: {
                  select: {
                    firstName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!ride) {
      throw new RideNotFoundError(`Ride '${idOrCode}' was not found`);
    }

    const baseDto = this.mapToListItemDto(ride);

    return {
      ...baseDto,
      waitTimeMin: ride.waitTimeMin,
      isScheduled: ride.isScheduled,
      scheduledFor: ride.request?.scheduledFor?.toISOString() ?? null,
      customer: {
        ...baseDto.customer,
        gender: ride.customer.profile?.gender ?? null,
        totalRatings: ride.customer.customerRatingAggregate?.totalRatings ?? 0,
      },
      driver: ride.driver
        ? {
            ...baseDto.driver!,
            totalRides: ride.driver.totalRides,
          }
        : null,
      fareBreakdown: ride.fare
        ? {
            currency: ride.fare.currency,
            baseFare: Number(ride.fare.baseFare),
            distanceFare: Number(ride.fare.distanceFare),
            timeFare: Number(ride.fare.timeFare),
            waitingCharge: Number(ride.fare.waitingCharge),
            surgeMultiplier: Number(ride.fare.surgeMultiplier),
            surgeAmount: Number(ride.fare.surgeAmount),
            subtotal: Number(ride.fare.subtotal),
            discountAmount: Number(ride.fare.discountAmount),
            taxAmount: Number(ride.fare.taxAmount),
            tollAmount: Number(ride.fare.tollAmount),
            platformFee: Number(ride.fare.platformFee),
            tipAmount: Number(ride.fare.tipAmount),
            totalFare: Number(ride.fare.totalFare),
            driverEarning: Number(ride.fare.driverEarning),
            platformCommission: Number(ride.fare.platformCommission),
            lines: (ride.fareLines ?? []).map((line) => ({
              id: line.id,
              lineType: line.lineType,
              label: line.label,
              amount: Number(line.amount),
              sequence: line.sequence,
            })),
          }
        : null,
      promosApplied: ride.promosApplied.map((p) => ({
        id: p.id,
        promoCode: p.promoCode,
        discountAmount: Number(p.discountAmount),
        createdAt: p.createdAt.toISOString(),
      })),
      cancellation: ride.cancellation
        ? {
            id: ride.cancellation.id,
            cancelledBy: ride.cancellation.cancelledBy,
            actorId: ride.cancellation.actorId,
            reasonCode: ride.cancellation.reasonCode,
            reasonText: ride.cancellation.reasonText,
            cancelledAtStatus: ride.cancellation.cancelledAtStatus,
            cancellationFee: Number(ride.cancellation.cancellationFee),
            feeCharged: ride.cancellation.feeCharged,
            createdAt: ride.cancellation.createdAt.toISOString(),
          }
        : null,
      receipt: ride.receipt
        ? {
            id: ride.receipt.id,
            receiptNumber: ride.receipt.receiptNumber,
            pdfUrl: ride.receipt.pdfUrl,
            issuedAt: ride.receipt.issuedAt.toISOString(),
          }
        : null,
      payments: ride.payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        method: p.method,
        status: p.status,
        settledAt: p.settledAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      })),
      ratings: ride.ratings.map((r) => ({
        id: r.id,
        ratedBy: r.ratedBy,
        rating: r.rating,
        tags: r.tags,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
      disputes: ride.disputes.map((d) => ({
        id: d.id,
        raisedBy: d.raisedBy,
        category: d.category,
        description: d.description,
        status: d.status,
        refundAmount: Number(d.refundAmount),
        createdAt: d.createdAt.toISOString(),
      })),
      stops: ride.stops.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        stopType: s.stopType,
        address: s.address,
        arrivedAt: s.arrivedAt?.toISOString() ?? null,
        departedAt: s.departedAt?.toISOString() ?? null,
      })),
      timeline: ride.statusEvents.map((e) => ({
        id: e.id,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorType: e.actorType,
        actorId: e.actorId,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      })),
      opsNotes: (ride.opsNotes ?? []).map((n) => ({
        id: n.id,
        note: n.note,
        createdAt: n.createdAt.toISOString(),
        author: {
          id: n.author.id,
          fullName:
            [n.author.profile?.firstName, n.author.profile?.lastName].filter(Boolean).join(' ') ||
            'Admin Staff',
          phoneNumber: n.author.phoneNumber,
        },
      })),
    };
  }

  async getTimeline(idOrCode: string) {
    const isUuid = UUID_REGEX.test(idOrCode);
    const ride = await this.client.ride.findFirst({
      where: isUuid ? { OR: [{ id: idOrCode }, { rideCode: idOrCode }] } : { rideCode: idOrCode },
      select: {
        id: true,
        rideCode: true,
        createdAt: true,
        statusEvents: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!ride) {
      throw new RideNotFoundError(`Ride '${idOrCode}' was not found`);
    }

    if (ride.statusEvents.length === 0) {
      return [
        {
          id: 'initial',
          fromStatus: null,
          toStatus: 'REQUESTED',
          actorType: 'SYSTEM',
          actorId: null,
          reason: 'Ride created',
          createdAt: ride.createdAt.toISOString(),
        },
      ];
    }

    return ride.statusEvents.map((e) => ({
      id: e.id,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actorType: e.actorType,
      actorId: e.actorId,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async getFareBreakdown(idOrCode: string) {
    const isUuid = UUID_REGEX.test(idOrCode);
    const ride = await this.client.ride.findFirst({
      where: isUuid ? { OR: [{ id: idOrCode }, { rideCode: idOrCode }] } : { rideCode: idOrCode },
      select: {
        id: true,
        rideCode: true,
        fare: true,
        fareLines: {
          orderBy: { sequence: 'asc' },
        },
        promosApplied: true,
      },
    });

    if (!ride) {
      throw new RideNotFoundError(`Ride '${idOrCode}' was not found`);
    }

    if (!ride.fare) {
      return null;
    }

    return {
      currency: ride.fare.currency,
      baseFare: Number(ride.fare.baseFare),
      distanceFare: Number(ride.fare.distanceFare),
      timeFare: Number(ride.fare.timeFare),
      waitingCharge: Number(ride.fare.waitingCharge),
      surgeMultiplier: Number(ride.fare.surgeMultiplier),
      surgeAmount: Number(ride.fare.surgeAmount),
      subtotal: Number(ride.fare.subtotal),
      discountAmount: Number(ride.fare.discountAmount),
      taxAmount: Number(ride.fare.taxAmount),
      tollAmount: Number(ride.fare.tollAmount),
      platformFee: Number(ride.fare.platformFee),
      tipAmount: Number(ride.fare.tipAmount),
      totalFare: Number(ride.fare.totalFare),
      driverEarning: Number(ride.fare.driverEarning),
      platformCommission: Number(ride.fare.platformCommission),
      lines: (ride.fareLines ?? []).map((line) => ({
        id: line.id,
        lineType: line.lineType,
        label: line.label,
        amount: Number(line.amount),
        sequence: line.sequence,
      })),
      promosApplied: ride.promosApplied.map((p) => ({
        id: p.id,
        promoCode: p.promoCode,
        discountAmount: Number(p.discountAmount),
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  async getPayments(idOrCode: string) {
    const isUuid = UUID_REGEX.test(idOrCode);
    const ride = await this.client.ride.findFirst({
      where: isUuid ? { OR: [{ id: idOrCode }, { rideCode: idOrCode }] } : { rideCode: idOrCode },
      select: {
        id: true,
        rideCode: true,
        paymentStatus: true,
        paymentMethod: true,
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!ride) {
      throw new RideNotFoundError(`Ride '${idOrCode}' was not found`);
    }

    const totalPaid = ride.payments
      .filter((p) => p.status === 'PAID' || p.status === 'SETTLED' || p.status === 'COMPLETED')
      .reduce((sum, p) => sum + Number(p.amount), 0);

    return {
      paymentStatus: ride.paymentStatus,
      paymentMethod: ride.paymentMethod,
      totalPaid,
      payments: ride.payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        method: p.method,
        status: p.status,
        settledAt: p.settledAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  async getDriverLocation(idOrCode: string) {
    const isUuid = UUID_REGEX.test(idOrCode);
    const ride = await this.client.ride.findFirst({
      where: isUuid ? { OR: [{ id: idOrCode }, { rideCode: idOrCode }] } : { rideCode: idOrCode },
      select: {
        id: true,
        driverId: true,
        status: true,
      },
    });

    if (!ride) {
      throw new RideNotFoundError(`Ride '${idOrCode}' was not found`);
    }

    if (!ride.driverId) {
      return {
        latitude: null,
        longitude: null,
        heading: null,
        bearing: null,
        speedKmh: null,
        recordedAt: null,
        isLive: false,
      };
    }

    const location = await this.client.driverLocation.findUnique({
      where: { driverId: ride.driverId },
    });

    if (!location) {
      return {
        latitude: null,
        longitude: null,
        heading: null,
        bearing: null,
        speedKmh: null,
        recordedAt: null,
        isLive: false,
      };
    }

    return {
      latitude: location.latitude ? Number(location.latitude) : null,
      longitude: location.longitude ? Number(location.longitude) : null,
      heading: location.heading ? Number(location.heading) : null,
      bearing: location.bearing ? Number(location.bearing) : null,
      speedKmh: location.speedKmh ? Number(location.speedKmh) : null,
      recordedAt: location.recordedAt?.toISOString() ?? null,
      isLive: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(
        ride.status,
      ),
    };
  }

  async getRoute(idOrCode: string) {
    const isUuid = UUID_REGEX.test(idOrCode);
    const ride = await this.client.ride.findFirst({
      where: isUuid ? { OR: [{ id: idOrCode }, { rideCode: idOrCode }] } : { rideCode: idOrCode },
      select: {
        id: true,
        request: {
          select: {
            pickupLat: true,
            pickupLng: true,
            dropLat: true,
            dropLng: true,
          },
        },
        routePlan: {
          select: {
            encodedPolyline: true,
          },
        },
      },
    });

    if (!ride) {
      throw new RideNotFoundError(`Ride '${idOrCode}' was not found`);
    }

    const pickupLat = ride.request?.pickupLat != null ? Number(ride.request.pickupLat) : null;
    const pickupLng = ride.request?.pickupLng != null ? Number(ride.request.pickupLng) : null;
    const dropLat = ride.request?.dropLat != null ? Number(ride.request.dropLat) : null;
    const dropLng = ride.request?.dropLng != null ? Number(ride.request.dropLng) : null;

    if (pickupLat == null || pickupLng == null || dropLat == null || dropLng == null) {
      return {
        path: [] as Array<{ lat: number; lng: number }>,
        provider: null,
        distanceMeters: null,
        durationSeconds: null,
      };
    }

    const storedPolyline = ride.routePlan?.encodedPolyline;
    if (storedPolyline) {
      return {
        path: coordinatesToLatLngPath(decodeEncodedPolyline(storedPolyline)),
        provider: 'stored',
        distanceMeters: null,
        durationSeconds: null,
        encodedPolyline: storedPolyline,
      };
    }

    if (!this.mapProviderService) {
      throw new RoutingProviderUnavailableError();
    }

    const routing = await this.mapProviderService.getDirections(
      { latitude: pickupLat, longitude: pickupLng },
      { latitude: dropLat, longitude: dropLng },
    );

    return {
      path: routing.path ? coordinatesToLatLngPath(routing.path) : [],
      provider: routing.providerName,
      distanceMeters: routing.distanceMeters,
      durationSeconds: routing.durationSeconds,
      ...(routing.encodedPolyline ? { encodedPolyline: routing.encodedPolyline } : {}),
    };
  }

  async exportCsv(query: ExportAdminRidesQuery): Promise<string> {
    const listResult = await this.list({
      ...query,
      page: 1,
      limit: 1000,
    });

    const headers = [
      'Ride Code',
      'Booking Time',
      'Status',
      'Payment Status',
      'Payment Method',
      'Customer Name',
      'Customer Phone',
      'Driver Name',
      'Driver Phone',
      'Vehicle Plate',
      'Vehicle Type',
      'Pickup Address',
      'Drop Address',
      'Distance (km)',
      'Duration (min)',
      'Quoted Fare',
      'Final Fare',
    ];

    const escapeCsv = (str: unknown): string => {
      if (str === null || str === undefined) return '';
      const s = String(str);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const rows = listResult.data.map((r) => [
      r.rideCode,
      r.bookingTime,
      r.status,
      r.paymentStatus,
      r.paymentMethod,
      r.customer.name,
      r.customer.phoneNumber,
      r.driver?.name ?? '',
      r.driver?.phoneNumber ?? '',
      r.vehicle?.plateNumber ?? '',
      r.vehicle?.vehicleType.name ?? '',
      r.pickupAddress ?? '',
      r.dropAddress ?? '',
      r.distanceKm ?? '',
      r.durationMin ?? '',
      r.quotedFare ?? '',
      r.finalFare ?? '',
    ]);

    const csvContent = [headers.join(','), ...rows.map((row) => row.map(escapeCsv).join(','))].join(
      '\n',
    );
    return csvContent;
  }

  async listNotes(idOrCode: string) {
    const ride = await this.resolveRide(idOrCode);
    const notes = await this.client.rideOpsNote.findMany({
      where: { rideId: ride.id },
      orderBy: { createdAt: 'desc' },
      include: {
        author: {
          select: {
            id: true,
            phoneNumber: true,
            profile: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    });

    return notes.map((n) => ({
      id: n.id,
      rideId: n.rideId,
      note: n.note,
      createdAt: n.createdAt.toISOString(),
      author: {
        id: n.author.id,
        fullName:
          [n.author.profile?.firstName, n.author.profile?.lastName].filter(Boolean).join(' ') ||
          'Admin Staff',
        phoneNumber: n.author.phoneNumber,
      },
    }));
  }

  async addNote(idOrCode: string, body: AddRideNoteBody, actorId?: string) {
    const ride = await this.resolveRide(idOrCode);
    const effectiveActorId = actorId || ride.customerId;

    const created = await this.client.$transaction(async (tx: PrismaTx) => {
      const noteRow = await tx.rideOpsNote.create({
        data: {
          rideId: ride.id,
          authorId: effectiveActorId,
          note: body.note,
        },
        include: {
          author: {
            select: {
              id: true,
              phoneNumber: true,
              profile: {
                select: {
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'ride',
        entityId: ride.id,
        summary: `Added internal ops note to ride ${ride.rideCode}`,
        after: { noteId: noteRow.id, note: noteRow.note },
      });

      return noteRow;
    });

    return {
      id: created.id,
      rideId: created.rideId,
      note: created.note,
      createdAt: created.createdAt.toISOString(),
      author: {
        id: created.author.id,
        fullName:
          [created.author.profile?.firstName, created.author.profile?.lastName]
            .filter(Boolean)
            .join(' ') || 'Admin Staff',
        phoneNumber: created.author.phoneNumber,
      },
    };
  }

  async cancelRide(idOrCode: string, body: CancelRideBody, actorId?: string) {
    const ride = await this.resolveRide(idOrCode);

    const cancelled = await this.lifecycleService.cancelRide(
      ride.id,
      'SYSTEM',
      actorId,
      body.reasonCode || 'ADMIN_CANCELLED',
      body.reasonText || 'Ride cancelled by operations admin',
    );

    await recordAdminAction(this.client, {
      actorId,
      action: 'UPDATE',
      entityType: 'ride',
      entityId: ride.id,
      summary: `Operations admin cancelled ride ${ride.rideCode}: ${body.reasonText || body.reasonCode}`,
      before: { status: ride.status },
      after: {
        status: cancelled.status,
        reasonCode: body.reasonCode,
        reasonText: body.reasonText,
      },
    });

    return this.getById(ride.id);
  }

  async getAuditLogs(idOrCode: string, query: ListRideAuditLogsQuery) {
    const ride = await this.resolveRide(idOrCode);
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const [total, logs] = await Promise.all([
      this.client.adminActivityLog.count({
        where: { entityType: 'ride', entityId: ride.id },
      }),
      this.client.adminActivityLog.findMany({
        where: { entityType: 'ride', entityId: ride.id },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          actor: {
            select: {
              id: true,
              phoneNumber: true,
              profile: {
                select: {
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
          fieldChanges: true,
        },
      }),
    ]);

    const data = logs.map((l) => ({
      id: l.id,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      summary: l.summary,
      ipAddress: l.ipAddress,
      userAgent: l.userAgent,
      metadata: l.metadata,
      createdAt: l.createdAt.toISOString(),
      actor: l.actor
        ? {
            id: l.actor.id,
            fullName:
              [l.actor.profile?.firstName, l.actor.profile?.lastName].filter(Boolean).join(' ') ||
              'Admin',
            phoneNumber: l.actor.phoneNumber,
          }
        : null,
      fieldChanges: l.fieldChanges.map((fc) => ({
        id: fc.id,
        fieldName: fc.fieldName,
        oldValue: fc.oldValue,
        newValue: fc.newValue,
      })),
    }));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  private async resolveRide(idOrCode: string) {
    const isUuid = UUID_REGEX.test(idOrCode);
    const ride = await this.client.ride.findFirst({
      where: isUuid ? { OR: [{ id: idOrCode }, { rideCode: idOrCode }] } : { rideCode: idOrCode },
    });
    if (!ride) {
      throw new RideNotFoundError(`Ride '${idOrCode}' was not found`);
    }
    return ride;
  }

  private mapToListItemDto(ride: RideMapSource): AdminRideListItemDto {
    const customerName =
      [ride.customer?.profile?.firstName, ride.customer?.profile?.lastName]
        .filter(Boolean)
        .join(' ') || 'Customer';

    const driverName = ride.driver
      ? ride.driver.profile?.fullLegalName ||
        [ride.driver.user?.profile?.firstName, ride.driver.user?.profile?.lastName]
          .filter(Boolean)
          .join(' ') ||
        'Driver'
      : null;

    const finalFare =
      ride.fare?.totalFare != null
        ? Number(ride.fare.totalFare)
        : ride.request?.quotedFare != null
          ? Number(ride.request.quotedFare)
          : null;

    const distanceKm =
      ride.actualDistanceKm != null
        ? Number(ride.actualDistanceKm)
        : ride.request?.estimatedDistanceKm != null
          ? Number(ride.request.estimatedDistanceKm)
          : null;

    const durationMin = ride.actualDurationMin ?? ride.request?.estimatedDurationMin ?? null;

    return {
      id: ride.id,
      rideCode: ride.rideCode,
      requestId: ride.requestId,
      status: ride.status,
      paymentMethod: ride.paymentMethod,
      paymentStatus: ride.paymentStatus,
      bookingTime: ride.createdAt.toISOString(),
      acceptedAt: ride.acceptedAt?.toISOString() ?? null,
      startedAt: ride.startedAt?.toISOString() ?? null,
      completedAt: ride.completedAt?.toISOString() ?? null,
      cancelledAt: ride.cancelledAt?.toISOString() ?? null,
      pickupAddress: ride.pickupAddress ?? null,
      dropAddress: ride.dropAddress ?? null,
      pickupLat: ride.request?.pickupLat != null ? Number(ride.request.pickupLat) : null,
      pickupLng: ride.request?.pickupLng != null ? Number(ride.request.pickupLng) : null,
      dropLat: ride.request?.dropLat != null ? Number(ride.request.dropLat) : null,
      dropLng: ride.request?.dropLng != null ? Number(ride.request.dropLng) : null,
      distanceKm,
      durationMin,
      quotedFare: ride.request?.quotedFare != null ? Number(ride.request.quotedFare) : null,
      finalFare,
      isScheduled: Boolean(ride.isScheduled),
      scheduledFor: ride.request?.scheduledFor?.toISOString() ?? null,
      customer: {
        id: ride.customer.id,
        name: customerName,
        phoneNumber: ride.customer.phoneNumber,
        email: ride.customer.email ?? null,
        ratingAvg:
          ride.customer.customerRatingAggregate?.avgRating != null
            ? Number(ride.customer.customerRatingAggregate.avgRating)
            : null,
      },
      driver: ride.driver
        ? {
            id: ride.driver.id,
            name: driverName ?? 'Driver',
            phoneNumber: ride.driver.user?.phoneNumber ?? '',
            driverCode: ride.driver.driverCode,
            rating: ride.driver.rating != null ? Number(ride.driver.rating) : null,
          }
        : null,
      vehicle: ride.vehicle
        ? {
            id: ride.vehicle.id,
            plateNumber: ride.vehicle.registrationNumber,
            make: ride.vehicle.make ?? null,
            model: ride.vehicle.model ?? null,
            color: ride.vehicle.color ?? null,
            vehicleType: {
              id: ride.vehicle.vehicleType.id,
              name: ride.vehicle.vehicleType.name,
              code: ride.vehicle.vehicleType.code,
            },
          }
        : null,
      createdAt: ride.createdAt.toISOString(),
      updatedAt: ride.updatedAt.toISOString(),
    };
  }
}
