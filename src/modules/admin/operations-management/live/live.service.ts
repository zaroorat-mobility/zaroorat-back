import { DatabaseService } from '@core/database';
import { Prisma } from '../../../../generated/prisma/index.js';
import {
  ActiveRidesQuery,
  LiveAlertsQuery,
  LiveDriversQuery,
  LiveMapQuery,
  LiveSummaryQuery,
} from './live.schemas.js';

export interface AdminLiveSummaryDto {
  activeRidesCount: number;
  searchingRequestsCount: number;
  assignedCount: number;
  inProgressCount: number;
  paymentPendingCount: number;
  completedTodayCount: number;
  cancelledTodayCount: number;
  longWaitCount: number;
  onlineDriversCount: number;
  availableDriversCount: number;
  busyDriversCount: number;
  offlineDriversCount: number;
}

export interface AdminActiveRideDto {
  id: string;
  rideCode: string;
  requestId: string;
  status: string;
  bookingTime: string;
  acceptedAt: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  elapsedMinutes: number;
  waitTimeMin: number;
  surgeMultiplier: number;
  quotedFare: number | null;
  totalFare: number | null;
  paymentMethod: string;
  paymentStatus: string;
  customer: {
    id: string;
    fullName: string;
    phone: string;
    avatarUrl: string | null;
  };
  driver: {
    id: string;
    fullName: string;
    phone: string;
    avatarUrl: string | null;
    ratingAvg: number | null;
  } | null;
  vehicle: {
    id: string | null;
    licensePlate: string | null;
    model: string | null;
    make: string | null;
    typeCode: string;
    typeName: string;
  };
  pickup: {
    address: string;
    lat: number;
    lng: number;
  };
  drop: {
    address: string;
    lat: number;
    lng: number;
  };
  driverLocation: {
    lat: number;
    lng: number;
    heading: number | null;
    speedKmh: number | null;
    updatedAt: string;
  } | null;
}

export interface AdminLiveMapDto {
  rides: Array<{
    id: string;
    rideCode: string;
    status: string;
    pickup: { address: string; lat: number; lng: number };
    drop: { address: string; lat: number; lng: number };
    driverLocation: { lat: number; lng: number; heading: number | null } | null;
    encodedPolyline: string | null;
  }>;
  drivers: Array<{
    id: string;
    name: string;
    phone: string;
    status: string;
    lat: number;
    lng: number;
    heading: number | null;
    vehicleType: string | null;
    currentRideId: string | null;
  }>;
}

export interface AdminLiveDriverDto {
  id: string;
  driverNumber: string;
  fullName: string;
  phoneNumber: string;
  avatarUrl: string | null;
  status: string;
  lastOnlineAt: string | null;
  lastOfflineAt: string | null;
  heartbeatAt: string | null;
  batteryLevel: number | null;
  appVersion: string | null;
  vehicle: {
    licensePlate: string | null;
    model: string | null;
    type: string;
  } | null;
  location: {
    lat: number;
    lng: number;
    heading: number | null;
    speedKmh: number | null;
    updatedAt: string;
  } | null;
  currentRide: {
    id: string;
    rideCode: string;
    status: string;
  } | null;
}

export interface AdminLiveAlertDto {
  id: string;
  type: 'LONG_WAIT' | 'SEARCHING_DELAY' | 'NO_DRIVERS' | 'PAYMENT_STALLED';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  message: string;
  entityId: string;
  entityType: 'ride' | 'request';
  timestamp: string;
}

export class AdminLiveService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async getSummary(query: LiveSummaryQuery): Promise<AdminLiveSummaryDto> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const nowOk = new Date();
    const longWaitThresholdTime = new Date(
      nowOk.getTime() - query.longWaitThresholdMin * 60 * 1000,
    );

    const [
      activeRides,
      searchingRequests,
      completedToday,
      cancelledToday,
      longWaitRides,
      longWaitRequests,
      driverStatuses,
    ] = await Promise.all([
      this.client.ride.findMany({
        where: {
          status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        },
        select: { status: true, paymentStatus: true },
      }),
      this.client.rideRequest.count({
        where: { status: { in: ['CREATED', 'SEARCHING'] } },
      }),
      this.client.ride.count({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: todayStart },
        },
      }),
      this.client.ride.count({
        where: {
          status: { in: ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_DRIVER', 'CANCELLED_BY_SYSTEM'] },
          cancelledAt: { gte: todayStart },
        },
      }),
      this.client.ride.count({
        where: {
          status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED'] },
          acceptedAt: { lte: longWaitThresholdTime },
        },
      }),
      this.client.rideRequest.count({
        where: {
          status: { in: ['CREATED', 'SEARCHING'] },
          createdAt: { lte: longWaitThresholdTime },
        },
      }),
      this.client.driverOnlineStatus.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    let assignedCount = 0;
    let inProgressCount = 0;
    let paymentPendingCount = 0;

    for (const r of activeRides) {
      if (r.status === 'IN_PROGRESS') {
        inProgressCount++;
      } else {
        assignedCount++;
      }
      if (r.paymentStatus === 'PENDING') {
        paymentPendingCount++;
      }
    }

    const driverCounts: Record<string, number> = {};
    for (const ds of driverStatuses) {
      driverCounts[ds.status] = ds._count._all;
    }

    const availableDriversCount = driverCounts['ONLINE'] ?? 0;
    const busyDriversCount = (driverCounts['ON_TRIP'] ?? 0) + (driverCounts['BUSY'] ?? 0);
    const offlineDriversCount = driverCounts['OFFLINE'] ?? 0;
    const onlineDriversCount =
      availableDriversCount + busyDriversCount + (driverCounts['BREAK'] ?? 0);

    return {
      activeRidesCount: activeRides.length,
      searchingRequestsCount: searchingRequests,
      assignedCount,
      inProgressCount,
      paymentPendingCount,
      completedTodayCount: completedToday,
      cancelledTodayCount: cancelledToday,
      longWaitCount: longWaitRides + longWaitRequests,
      onlineDriversCount,
      availableDriversCount,
      busyDriversCount,
      offlineDriversCount,
    };
  }

  async getActiveRides(query: ActiveRidesQuery): Promise<{
    data: AdminActiveRideDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const where: Prisma.RideWhereInput = {};
    if (query.status === 'all') {
      where.status = { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] };
    } else {
      where.status = query.status;
    }

    if (query.search) {
      const search = query.search;
      where.OR = [
        { rideCode: { contains: search, mode: 'insensitive' } },
        { customer: { profile: { firstName: { contains: search, mode: 'insensitive' } } } },
        { customer: { profile: { lastName: { contains: search, mode: 'insensitive' } } } },
        { driver: { user: { profile: { firstName: { contains: search, mode: 'insensitive' } } } } },
        { driver: { user: { profile: { lastName: { contains: search, mode: 'insensitive' } } } } },
        { pickupAddress: { contains: search, mode: 'insensitive' } },
        { dropAddress: { contains: search, mode: 'insensitive' } },
      ];
    }

    const total = await this.client.ride.count({ where });
    const page = query.page;
    const limit = query.limit;
    const totalPages = Math.ceil(total / limit) || 1;

    const rides = await this.client.ride.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { include: { profile: true } },
        driver: {
          include: {
            profile: true,
            user: { include: { profile: true } },
            ratingAggregate: true,
            location: true,
          },
        },
        vehicle: true,
        vehicleType: true,
        fare: true,
        request: true,
      },
    });

    const now = new Date();
    const data: AdminActiveRideDto[] = rides.map((ride) => {
      const baseTime = ride.startedAt ?? ride.acceptedAt ?? ride.createdAt;
      const elapsedMinutes = Math.max(0, Math.round((now.getTime() - baseTime.getTime()) / 60000));

      const driverLocation = ride.driver?.location
        ? {
            lat: Number(ride.driver.location.latitude ?? 0),
            lng: Number(ride.driver.location.longitude ?? 0),
            heading: ride.driver.location.heading ? Number(ride.driver.location.heading) : null,
            speedKmh: ride.driver.location.speedKmh ? Number(ride.driver.location.speedKmh) : null,
            updatedAt: ride.driver.location.recordedAt.toISOString(),
          }
        : null;

      const driverName =
        [ride.driver?.user?.profile?.firstName, ride.driver?.user?.profile?.lastName]
          .filter(Boolean)
          .join(' ') ||
        ride.driver?.profile?.fullLegalName ||
        'Driver';

      const customerName =
        [ride.customer.profile?.firstName, ride.customer.profile?.lastName]
          .filter(Boolean)
          .join(' ') || 'Customer';

      return {
        id: ride.id,
        rideCode: ride.rideCode,
        requestId: ride.requestId,
        status: ride.status,
        bookingTime: ride.createdAt.toISOString(),
        acceptedAt: ride.acceptedAt ? ride.acceptedAt.toISOString() : null,
        arrivedAt: ride.arrivedAt ? ride.arrivedAt.toISOString() : null,
        startedAt: ride.startedAt ? ride.startedAt.toISOString() : null,
        elapsedMinutes,
        waitTimeMin: ride.waitTimeMin,
        surgeMultiplier: ride.fare
          ? Number(ride.fare.surgeMultiplier)
          : Number(ride.request?.surgeMultiplier ?? 1.0),
        quotedFare: ride.request?.quotedFare ? Number(ride.request.quotedFare) : null,
        totalFare: ride.fare?.totalFare ? Number(ride.fare.totalFare) : null,
        paymentMethod: ride.paymentMethod,
        paymentStatus: ride.paymentStatus,
        customer: {
          id: ride.customer.id,
          fullName: customerName,
          phone: ride.customer.phoneNumber,
          avatarUrl: null,
        },
        driver: ride.driver
          ? {
              id: ride.driver.id,
              fullName: driverName,
              phone: ride.driver.user?.phoneNumber ?? '',
              avatarUrl: ride.driver.profile?.profilePhoto ?? null,
              ratingAvg: ride.driver.ratingAggregate?.avgRating
                ? Number(ride.driver.ratingAggregate.avgRating)
                : null,
            }
          : null,
        vehicle: {
          id: ride.vehicle?.id ?? null,
          licensePlate: ride.vehicle?.registrationNumber ?? null,
          model: ride.vehicle?.model ?? null,
          make: ride.vehicle?.make ?? null,
          typeCode: ride.vehicleType.code,
          typeName: ride.vehicleType.name,
        },
        pickup: {
          address: ride.pickupAddress ?? '',
          lat: Number(ride.request?.pickupLat ?? 0),
          lng: Number(ride.request?.pickupLng ?? 0),
        },
        drop: {
          address: ride.dropAddress ?? '',
          lat: Number(ride.request?.dropLat ?? 0),
          lng: Number(ride.request?.dropLng ?? 0),
        },
        driverLocation,
      };
    });

    return { data, meta: { page, limit, total, totalPages } };
  }

  async getMap(query: LiveMapQuery): Promise<AdminLiveMapDto> {
    const activeRides = await this.client.ride.findMany({
      where: {
        status: { in: ['ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        ...(query.vehicleTypeId ? { vehicleTypeId: query.vehicleTypeId } : {}),
      },
      include: {
        request: true,
        routePlan: true,
        driver: {
          include: { location: true },
        },
      },
    });

    const rides = activeRides.map((ride) => {
      const driverLoc = ride.driver?.location
        ? {
            lat: Number(ride.driver.location.latitude ?? 0),
            lng: Number(ride.driver.location.longitude ?? 0),
            heading: ride.driver.location.heading ? Number(ride.driver.location.heading) : null,
          }
        : null;

      return {
        id: ride.id,
        rideCode: ride.rideCode,
        status: ride.status,
        pickup: {
          address: ride.pickupAddress ?? '',
          lat: Number(ride.request?.pickupLat ?? 0),
          lng: Number(ride.request?.pickupLng ?? 0),
        },
        drop: {
          address: ride.dropAddress ?? '',
          lat: Number(ride.request?.dropLat ?? 0),
          lng: Number(ride.request?.dropLng ?? 0),
        },
        driverLocation: driverLoc,
        encodedPolyline: ride.routePlan?.encodedPolyline ?? null,
      };
    });

    const driversWithLocation = await this.client.driver.findMany({
      where: {
        location: { isNot: null },
      },
      include: {
        profile: true,
        user: { include: { profile: true } },
        onlineStatus: true,
        location: true,
        assignments: {
          where: { status: 'ACTIVE' },
          include: { vehicle: { include: { vehicleType: true } } },
        },
      },
    });

    const drivers = driversWithLocation
      .filter((d) => d.onlineStatus && d.onlineStatus.status !== 'OFFLINE')
      .map((d) => {
        const vehicleType = d.assignments?.[0]?.vehicle?.vehicleType?.name ?? null;
        const driverName =
          [d.user?.profile?.firstName, d.user?.profile?.lastName].filter(Boolean).join(' ') ||
          d.profile?.fullLegalName ||
          'Driver';
        return {
          id: d.id,
          name: driverName,
          phone: d.user?.phoneNumber ?? '',
          status: d.onlineStatus?.status ?? 'OFFLINE',
          lat: Number(d.location?.latitude ?? 0),
          lng: Number(d.location?.longitude ?? 0),
          heading: d.location?.heading ? Number(d.location.heading) : null,
          vehicleType,
          currentRideId: d.location?.rideId ?? null,
        };
      });

    return { rides, drivers };
  }

  async getDrivers(query: LiveDriversQuery): Promise<{
    data: AdminLiveDriverDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const where: Prisma.DriverWhereInput = {};
    if (query.status !== 'all') {
      where.onlineStatus = { status: query.status };
    }
    if (query.search) {
      const search = query.search;
      where.OR = [
        { driverCode: { contains: search, mode: 'insensitive' } },
        { user: { profile: { firstName: { contains: search, mode: 'insensitive' } } } },
        { user: { profile: { lastName: { contains: search, mode: 'insensitive' } } } },
        { user: { phoneNumber: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const total = await this.client.driver.count({ where });
    const page = query.page;
    const limit = query.limit;
    const totalPages = Math.ceil(total / limit) || 1;

    const drivers = await this.client.driver.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        profile: true,
        user: { include: { profile: true } },
        onlineStatus: true,
        location: true,
        assignments: {
          where: { status: 'ACTIVE' },
          include: { vehicle: { include: { vehicleType: true } } },
        },
      },
    });

    const activeRideIds = drivers
      .map((d) => d.location?.rideId)
      .filter((id): id is string => Boolean(id));
    const activeRides =
      activeRideIds.length > 0
        ? await this.client.ride.findMany({
            where: { id: { in: activeRideIds } },
            select: { id: true, rideCode: true, status: true, driverId: true },
          })
        : [];

    const rideByDriverId = new Map<string, { id: string; rideCode: string; status: string }>();
    for (const r of activeRides) {
      if (r.driverId) {
        rideByDriverId.set(r.driverId, { id: r.id, rideCode: r.rideCode, status: r.status });
      }
    }

    const data: AdminLiveDriverDto[] = drivers.map((d) => {
      const currentRide = rideByDriverId.get(d.id) ?? null;
      const activeVehicle = d.assignments?.[0]?.vehicle ?? null;
      const driverName =
        [d.user?.profile?.firstName, d.user?.profile?.lastName].filter(Boolean).join(' ') ||
        d.profile?.fullLegalName ||
        'Driver';

      return {
        id: d.id,
        driverNumber: d.driverCode,
        fullName: driverName,
        phoneNumber: d.user?.phoneNumber ?? '',
        avatarUrl: d.profile?.profilePhoto ?? null,
        status: d.onlineStatus?.status ?? 'OFFLINE',
        lastOnlineAt: d.onlineStatus?.lastOnlineAt
          ? d.onlineStatus.lastOnlineAt.toISOString()
          : null,
        lastOfflineAt: d.onlineStatus?.lastOfflineAt
          ? d.onlineStatus.lastOfflineAt.toISOString()
          : null,
        heartbeatAt: d.onlineStatus?.heartbeatAt ? d.onlineStatus.heartbeatAt.toISOString() : null,
        batteryLevel: d.onlineStatus?.batteryLevel ?? null,
        appVersion: d.onlineStatus?.appVersion ?? null,
        vehicle: activeVehicle
          ? {
              licensePlate: activeVehicle.registrationNumber,
              model: activeVehicle.model,
              type: activeVehicle.vehicleType.name,
            }
          : null,
        location: d.location
          ? {
              lat: Number(d.location.latitude ?? 0),
              lng: Number(d.location.longitude ?? 0),
              heading: d.location.heading ? Number(d.location.heading) : null,
              speedKmh: d.location.speedKmh ? Number(d.location.speedKmh) : null,
              updatedAt: d.location.recordedAt.toISOString(),
            }
          : null,
        currentRide,
      };
    });

    return { data, meta: { page, limit, total, totalPages } };
  }

  async getAlerts(query: LiveAlertsQuery): Promise<AdminLiveAlertDto[]> {
    const alerts: AdminLiveAlertDto[] = [];
    const now = new Date();
    const thresholdTime = new Date(now.getTime() - query.longWaitThresholdMin * 60 * 1000);

    // 1. Searching ride requests delayed
    const delayedRequests = await this.client.rideRequest.findMany({
      where: {
        status: { in: ['CREATED', 'SEARCHING'] },
        createdAt: { lte: thresholdTime },
      },
      take: 10,
    });

    const userIds = delayedRequests.map((r) => r.customerId);
    const users =
      userIds.length > 0
        ? await this.client.user.findMany({
            where: { id: { in: userIds } },
            include: { profile: true },
          })
        : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    for (const req of delayedRequests) {
      const waitMin = Math.round((now.getTime() - req.createdAt.getTime()) / 60000);
      const user = userMap.get(req.customerId);
      const customerName =
        [user?.profile?.firstName, user?.profile?.lastName].filter(Boolean).join(' ') ||
        'Passenger';
      alerts.push({
        id: `REQ-${req.id}`,
        type: 'SEARCHING_DELAY',
        severity: waitMin > 10 ? 'HIGH' : 'MEDIUM',
        title: 'Searching Delayed',
        message: `Customer ${customerName} waiting ${waitMin} min for a driver assignment`,
        entityId: req.id,
        entityType: 'request',
        timestamp: req.createdAt.toISOString(),
      });
    }

    // 2. Rides in arriving status waiting too long
    const delayedRides = await this.client.ride.findMany({
      where: {
        status: { in: ['ACCEPTED', 'DRIVER_ARRIVING'] },
        acceptedAt: { lte: thresholdTime },
      },
      include: {
        driver: { include: { profile: true, user: { include: { profile: true } } } },
      },
      take: 10,
    });

    for (const ride of delayedRides) {
      const waitMin = ride.acceptedAt
        ? Math.round((now.getTime() - ride.acceptedAt.getTime()) / 60000)
        : 0;
      const driverName =
        [ride.driver?.user?.profile?.firstName, ride.driver?.user?.profile?.lastName]
          .filter(Boolean)
          .join(' ') ||
        ride.driver?.profile?.fullLegalName ||
        'Driver';
      alerts.push({
        id: `RIDE-${ride.id}`,
        type: 'LONG_WAIT',
        severity: waitMin > 15 ? 'HIGH' : 'MEDIUM',
        title: 'Driver Arrival Delayed',
        message: `Ride ${ride.rideCode}: Driver ${driverName} en route for ${waitMin} min`,
        entityId: ride.id,
        entityType: 'ride',
        timestamp: (ride.acceptedAt ?? ride.createdAt).toISOString(),
      });
    }

    // 3. Recent EXPIRED requests
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const noDriverRequests = await this.client.rideRequest.findMany({
      where: {
        status: 'EXPIRED',
        createdAt: { gte: oneHourAgo },
      },
      take: 5,
      orderBy: { createdAt: 'desc' },
    });

    for (const req of noDriverRequests) {
      alerts.push({
        id: `EXPIRED-${req.id}`,
        type: 'NO_DRIVERS',
        severity: 'LOW',
        title: 'No Drivers Found',
        message: `Trip request near ${req.pickupAddress ?? 'pickup'} expired with no drivers found`,
        entityId: req.id,
        entityType: 'request',
        timestamp: req.createdAt.toISOString(),
      });
    }

    return alerts;
  }
}
