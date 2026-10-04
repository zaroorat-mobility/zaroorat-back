import { DatabaseService } from '@core/database';
import type { UserStatus } from '@core/database/types';
import { SessionService } from '@modules/auth/services/session/session.service.js';
import type { EpochService } from '@modules/auth/services/token/epoch.service.js';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { recordAdminAction, type AuditActor } from '../audit/index.js';
import { RiderConflictError, RiderNotFoundError } from './rider.errors.js';
import type { ListRidersQuery, RiderStatusDto } from './rider.schemas.js';

type RiderListRow = {
  id: string;
  phoneNumber: string;
  email: string | null;
  status: UserStatus;
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  ridePinVerifier: string | null;
  ridePinUpdatedAt: Date | null;
  ridePinVersion: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  profile: {
    firstName: string | null;
    lastName: string | null;
    gender: string | null;
    dateOfBirth: Date | null;
    languageCode: string | null;
    referralCode: string | null;
    profileImageFileId: string | null;
  } | null;
  customerWallet: { balance: { toString(): string } } | null;
  customerRatingAggregate: {
    avgRating: { toString(): string };
    totalRatings: number;
    star1: number;
    star2: number;
    star3: number;
    star4: number;
    star5: number;
    lastRatedAt: Date | null;
  } | null;
  emergencyContacts: Array<{
    id: string;
    contactName: string;
    phoneNumber: string;
    relationship: string | null;
    priority: number;
    createdAt: Date;
  }>;
  _count: { customerRides: number };
};

export interface RiderListItemDto {
  id: string;
  riderId: string;
  fullName: string;
  mobileNumber: string;
  email?: string;
  gender?: string;
  dateOfBirth?: string;
  riderStatus: RiderStatusDto;
  ratingAvg: number;
  totalRides: number;
  walletBalance: number;
  joinedAt: string;
  lastActiveAt?: string;
  emergencyContacts: Array<{ name: string; phone: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface RiderDeviceDto {
  id: string;
  deviceId?: string;
  platform?: string;
  trustState: string;
  appVersion?: string;
  osVersion?: string;
  isRooted: boolean;
  isJailbroken: boolean;
  hasPushToken: boolean;
  lastSeenAt?: string;
  createdAt: string;
}

export interface RiderSavedPlaceDto {
  id: string;
  label: string;
  address?: string;
  buildingName?: string;
  landmark?: string;
  floor?: string;
  instructions?: string;
  latitude?: number;
  longitude?: number;
  createdAt: string;
}

export interface RiderEmergencyContactDetailDto {
  id: string;
  name: string;
  phone: string;
  relationship?: string;
  priority: number;
}

export interface RiderSupportTicketDto {
  id: string;
  ticketNumber: string;
  subject: string;
  category?: string;
  status: string;
  priority: string;
  channel: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface RiderReviewDto {
  id: string;
  rideCode: string;
  rating: number;
  ratedBy: 'DRIVER' | 'CUSTOMER';
  driverName?: string;
  driverPhone?: string;
  tags: string[];
  comment?: string;
  createdAt: string;
}

export interface RiderRideStatsDto {
  totalRides: number;
  completedRides: number;
  cancelledByCustomer: number;
  cancelledByDriver: number;
  totalSpent: number;
  cancelRate: number;
  noShowCount: number;
}

export interface RiderRatingBreakdownDto {
  avgRating: number;
  totalRatings: number;
  star5: number;
  star4: number;
  star3: number;
  star2: number;
  star1: number;
}

export interface RiderRideHistoryItemDto {
  id: string;
  rideId: string;
  date: string;
  pickupAddress: string;
  dropAddress: string;
  fare: number;
  paymentMethod: string;
  status: string;
  driverName?: string;
  driverPhone?: string;
  vehicleType?: string;
  vehiclePlate?: string;
  cancellationReason?: string;
  cancelledBy?: string;
}

export interface RiderDetailsDto extends RiderListItemDto {
  country?: string;
  state?: string;
  city?: string;
  postcode?: string;
  addressLine1?: string;
  addressLine2?: string;
  preferredPaymentMethod?: 'cash' | 'upi' | 'card' | 'wallet';
  isPhoneVerified: boolean;
  isEmailVerified: boolean;
  hasRidePin: boolean;
  ridePinVersion: number;
  ridePinUpdatedAt?: string;
  languageCode: string;
  referralCode?: string;
  referralsCount: number;
  deletionRequest?: {
    status: string;
    requestedAt: string;
    scheduledFor: string;
  };
  stats: RiderRideStatsDto;
  ratingBreakdown: RiderRatingBreakdownDto;
  devices: RiderDeviceDto[];
  savedPlaces: RiderSavedPlaceDto[];
  emergencyContactsList: RiderEmergencyContactDetailDto[];
  supportTickets: RiderSupportTicketDto[];
  reviews: RiderReviewDto[];
  cancelRate: number;
  noShowCount: number;
  safetyIncidentsCount: number;
  ledger: Array<{
    id: string;
    date: string;
    type: 'TOPUP' | 'PAYMENT' | 'REFUND' | 'CASHBACK';
    amount: number;
    balanceAfter: number;
    rideId?: string;
  }>;
  rideHistory: RiderRideHistoryItemDto[];
  timeline: Array<{
    id: string;
    action: string;
    actor: string;
    timestamp: string;
    notes?: string;
    isSystem?: boolean;
  }>;
  auditLogs: Array<{
    action: string;
    operator: string;
    timestamp: string;
    notes?: string;
  }>;
}

function displayName(
  profile: { firstName: string | null; lastName: string | null } | null,
  phone: string,
): string {
  const parts = [profile?.firstName, profile?.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return phone;
}

function riderDisplayId(id: string): string {
  return `CUST-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function toRiderStatus(status: UserStatus): RiderStatusDto {
  if (status === 'SUSPENDED') return 'suspended';
  if (status === 'DEACTIVATED') return 'blocked';
  return 'active';
}

function statusesForFilter(status: ListRidersQuery['status']): UserStatus[] | undefined {
  if (!status || status === 'all') return undefined;
  if (status === 'active') return ['ACTIVE', 'UNVERIFIED'];
  if (status === 'suspended') return ['SUSPENDED'];
  return ['DEACTIVATED'];
}

function mapLedgerType(txnType: string): 'TOPUP' | 'PAYMENT' | 'REFUND' | 'CASHBACK' {
  const normalized = txnType.trim().toUpperCase();
  if (normalized === 'TOPUP' || normalized === 'TOP_UP') return 'TOPUP';
  if (normalized === 'REFUND') return 'REFUND';
  if (normalized === 'CASHBACK') return 'CASHBACK';
  return 'PAYMENT';
}

function mapPreferredPayment(
  methodType: string | undefined,
): RiderDetailsDto['preferredPaymentMethod'] {
  if (!methodType) return undefined;
  const normalized = methodType.trim().toLowerCase();
  if (normalized === 'cash') return 'cash';
  if (normalized === 'upi') return 'upi';
  if (normalized === 'card' || normalized === 'credit_card' || normalized === 'debit_card') {
    return 'card';
  }
  if (normalized === 'wallet') return 'wallet';
  return undefined;
}

export class AdminRiderService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly userRepository: UserRepository,
    private readonly sessionService: SessionService,
    private readonly epochService: EpochService,
  ) {}

  async list(query: ListRidersQuery): Promise<{
    data: RiderListItemDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const skip = (query.page - 1) * query.limit;
    const where = this.riderWhere(query);
    const [rows, totalCount] = await Promise.all([
      this.databaseService.client.user.findMany({
        where,
        include: {
          profile: true,
          customerWallet: true,
          customerRatingAggregate: true,
          emergencyContacts: { orderBy: { priority: 'asc' }, take: 5 },
          _count: { select: { customerRides: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
      }),
      this.databaseService.client.user.count({ where }),
    ]);

    const data = (rows as RiderListRow[]).map((row) => this.toListDto(row));
    const totalPages = Math.max(1, Math.ceil(totalCount / query.limit));
    return {
      data,
      meta: {
        currentPage: query.page,
        totalPages,
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getById(id: string): Promise<RiderDetailsDto> {
    const row = await this.findRiderRow(id);
    if (!row) throw new RiderNotFoundError();

    const [
      rides,
      walletTxns,
      activityLogs,
      paymentMethod,
      cancelStats,
      devices,
      savedPlaces,
      supportTickets,
      reviews,
      referralsCount,
      deletionRequest,
      safetyIncidentsCount,
    ] = await Promise.all([
      this.databaseService.client.ride.findMany({
        where: { customerId: id },
        include: {
          fare: true,
          driver: {
            include: {
              user: { include: { profile: true } },
            },
          },
          vehicle: true,
          vehicleType: true,
          cancellation: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.databaseService.client.customerWalletTransaction.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.databaseService.client.adminActivityLog.findMany({
        where: { entityType: 'rider', entityId: id },
        include: { actor: { include: { profile: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.databaseService.client.paymentInstrument.findFirst({
        where: { userId: id, isActive: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      }),
      this.computeCancelStats(id),
      this.databaseService.client.userDevice.findMany({
        where: { userId: id },
        orderBy: { lastSeenAt: 'desc' },
        take: 10,
      }),
      this.databaseService.client.savedPlace.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.databaseService.client.supportTicket.findMany({
        where: { userId: id },
        include: { category: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.databaseService.client.rideRating.findMany({
        where: { ride: { customerId: id } },
        include: {
          ride: {
            select: {
              rideCode: true,
              driver: {
                select: {
                  user: {
                    select: {
                      phoneNumber: true,
                      profile: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.databaseService.client.referral.count({
        where: { referrerId: id },
      }),
      this.databaseService.client.accountDeletionRequest.findFirst({
        where: { userId: id },
        orderBy: { requestedAt: 'desc' },
      }),
      this.databaseService.client.safetyIncident.count({
        where: {
          OR: [{ reporterUserId: id }, { subjectUserId: id }, { ride: { customerId: id } }],
        },
      }),
    ]);

    const base = this.toListDto(row);
    const timeline = [
      {
        id: `created-${row.id}`,
        action: 'Rider Profile Created',
        actor: 'System',
        timestamp: row.createdAt.toISOString(),
        isSystem: true as const,
      },
      ...activityLogs.map((log) => {
        const actorName = log.actor
          ? displayName(log.actor.profile, log.actor.phoneNumber)
          : 'System';
        const notes =
          log.metadata &&
          typeof log.metadata === 'object' &&
          log.metadata !== null &&
          'notes' in log.metadata &&
          typeof (log.metadata as { notes?: unknown }).notes === 'string'
            ? (log.metadata as { notes: string }).notes
            : (log.summary ?? undefined);
        return {
          id: log.id,
          action: log.summary ?? log.action,
          actor: actorName,
          timestamp: log.createdAt.toISOString(),
          ...(notes ? { notes } : {}),
          isSystem: !log.actorId,
        };
      }),
    ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const preferredPaymentMethod = mapPreferredPayment(paymentMethod?.methodType);

    return {
      ...base,
      ...(preferredPaymentMethod ? { preferredPaymentMethod } : {}),
      isPhoneVerified: row.isPhoneVerified,
      isEmailVerified: row.isEmailVerified,
      hasRidePin: Boolean(row.ridePinVerifier),
      ridePinVersion: row.ridePinVersion,
      ...(row.ridePinUpdatedAt ? { ridePinUpdatedAt: row.ridePinUpdatedAt.toISOString() } : {}),
      languageCode: row.profile?.languageCode ?? 'en',
      ...(row.profile?.referralCode ? { referralCode: row.profile.referralCode } : {}),
      referralsCount,
      ...(deletionRequest
        ? {
            deletionRequest: {
              status: deletionRequest.status,
              requestedAt: deletionRequest.requestedAt.toISOString(),
              scheduledFor: deletionRequest.scheduledFor.toISOString(),
            },
          }
        : {}),
      stats: {
        totalRides: cancelStats.totalRides,
        completedRides: cancelStats.completedRides,
        cancelledByCustomer: cancelStats.cancelledByCustomer,
        cancelledByDriver: cancelStats.cancelledByDriver,
        totalSpent: cancelStats.totalSpent,
        cancelRate: cancelStats.cancelRate,
        noShowCount: cancelStats.noShowCount,
      },
      ...(() => {
        const driverReviews = reviews.filter((r) => r.ratedBy === 'DRIVER');
        const hasAggregate = Boolean(
          row.customerRatingAggregate && row.customerRatingAggregate.totalRatings > 0,
        );

        const totalRatings = hasAggregate
          ? row.customerRatingAggregate!.totalRatings
          : driverReviews.length;
        const star5 = hasAggregate
          ? row.customerRatingAggregate!.star5
          : driverReviews.filter((r) => r.rating === 5).length;
        const star4 = hasAggregate
          ? row.customerRatingAggregate!.star4
          : driverReviews.filter((r) => r.rating === 4).length;
        const star3 = hasAggregate
          ? row.customerRatingAggregate!.star3
          : driverReviews.filter((r) => r.rating === 3).length;
        const star2 = hasAggregate
          ? row.customerRatingAggregate!.star2
          : driverReviews.filter((r) => r.rating === 2).length;
        const star1 = hasAggregate
          ? row.customerRatingAggregate!.star1
          : driverReviews.filter((r) => r.rating === 1).length;
        const avgRating = hasAggregate
          ? Number(row.customerRatingAggregate!.avgRating)
          : totalRatings > 0
            ? Number(
                (driverReviews.reduce((sum, r) => sum + r.rating, 0) / totalRatings).toFixed(2),
              )
            : row.customerRatingAggregate
              ? Number(row.customerRatingAggregate.avgRating) || 5
              : 5;

        return {
          ratingBreakdown: {
            avgRating,
            totalRatings,
            star5,
            star4,
            star3,
            star2,
            star1,
          },
        };
      })(),
      safetyIncidentsCount,
      devices: devices.map((d) => ({
        id: d.id,
        ...(d.deviceId ? { deviceId: d.deviceId } : {}),
        ...(d.platform ? { platform: d.platform } : {}),
        trustState: d.trustState,
        ...(d.appVersion ? { appVersion: d.appVersion } : {}),
        ...(d.osVersion ? { osVersion: d.osVersion } : {}),
        isRooted: d.isRooted,
        isJailbroken: d.isJailbroken,
        hasPushToken: Boolean(d.fcmToken),
        ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt.toISOString() } : {}),
        createdAt: d.createdAt.toISOString(),
      })),
      savedPlaces: savedPlaces.map((sp) => ({
        id: sp.id,
        label: sp.label,
        ...(sp.address ? { address: sp.address } : {}),
        ...(sp.buildingName ? { buildingName: sp.buildingName } : {}),
        ...(sp.landmark ? { landmark: sp.landmark } : {}),
        ...(sp.floor ? { floor: sp.floor } : {}),
        ...(sp.instructions ? { instructions: sp.instructions } : {}),
        ...(sp.latitude !== null && sp.latitude !== undefined
          ? { latitude: Number(sp.latitude) }
          : {}),
        ...(sp.longitude !== null && sp.longitude !== undefined
          ? { longitude: Number(sp.longitude) }
          : {}),
        createdAt: sp.createdAt.toISOString(),
      })),
      emergencyContactsList: row.emergencyContacts.map((c) => ({
        id: c.id,
        name: c.contactName,
        phone: c.phoneNumber,
        ...(c.relationship ? { relationship: c.relationship } : {}),
        priority: c.priority,
      })),
      supportTickets: supportTickets.map((st) => ({
        id: st.id,
        ticketNumber: st.ticketNumber,
        subject: st.subject,
        ...(st.category?.name ? { category: st.category.name } : {}),
        status: st.status,
        priority: st.priority,
        channel: st.channel,
        createdAt: st.createdAt.toISOString(),
        ...(st.resolvedAt ? { resolvedAt: st.resolvedAt.toISOString() } : {}),
      })),
      reviews: reviews.map((r) => {
        const driverUser = r.ride.driver?.user;
        const driverName = driverUser
          ? displayName(driverUser.profile, driverUser.phoneNumber)
          : undefined;
        return {
          id: r.id,
          rideCode: r.ride.rideCode,
          rating: r.rating,
          ratedBy: r.ratedBy as 'DRIVER' | 'CUSTOMER',
          ...(driverName ? { driverName } : {}),
          ...(driverUser?.phoneNumber ? { driverPhone: driverUser.phoneNumber } : {}),
          tags: r.tags,
          ...(r.comment ? { comment: r.comment } : {}),
          createdAt: r.createdAt.toISOString(),
        };
      }),
      cancelRate: cancelStats.cancelRate,
      noShowCount: cancelStats.noShowCount,
      ledger: walletTxns.map((txn) => ({
        id: txn.id,
        date: txn.createdAt.toISOString(),
        type: mapLedgerType(txn.txnType),
        amount: Number(txn.amount),
        balanceAfter: Number(txn.balanceAfter),
        ...(txn.referenceType === 'ride' && txn.referenceId ? { rideId: txn.referenceId } : {}),
      })),
      rideHistory: rides.map((ride) => {
        const driverUser = ride.driver?.user;
        const driverName = driverUser
          ? displayName(driverUser.profile, driverUser.phoneNumber)
          : undefined;
        const vehicleDesc = [ride.vehicle?.make, ride.vehicle?.model].filter(Boolean).join(' ');
        return {
          id: ride.rideCode,
          rideId: ride.id,
          date: ride.createdAt.toISOString(),
          pickupAddress: ride.pickupAddress ?? '—',
          dropAddress: ride.dropAddress ?? '—',
          fare: ride.fare ? Number(ride.fare.totalFare) : 0,
          paymentMethod: ride.paymentMethod.toLowerCase(),
          status: ride.status.toLowerCase(),
          ...(driverName ? { driverName } : {}),
          ...(driverUser?.phoneNumber ? { driverPhone: driverUser.phoneNumber } : {}),
          ...(ride.vehicleType?.name ? { vehicleType: ride.vehicleType.name } : {}),
          ...(ride.vehicle?.registrationNumber
            ? { vehiclePlate: ride.vehicle.registrationNumber }
            : vehicleDesc
              ? { vehiclePlate: vehicleDesc }
              : {}),
          ...(ride.cancellation?.reasonText || ride.cancellation?.reasonCode
            ? { cancellationReason: ride.cancellation.reasonText ?? ride.cancellation.reasonCode }
            : {}),
          ...(ride.cancellation?.cancelledBy ? { cancelledBy: ride.cancellation.cancelledBy } : {}),
        };
      }),
      timeline,
      auditLogs: activityLogs.map((log) => {
        const operator = log.actor
          ? displayName(log.actor.profile, log.actor.phoneNumber)
          : 'System';
        const notes =
          log.metadata &&
          typeof log.metadata === 'object' &&
          log.metadata !== null &&
          'notes' in log.metadata &&
          typeof (log.metadata as { notes?: unknown }).notes === 'string'
            ? (log.metadata as { notes: string }).notes
            : undefined;
        return {
          action: log.summary ?? log.action,
          operator,
          timestamp: log.createdAt.toISOString(),
          ...(notes ? { notes } : {}),
        };
      }),
    };
  }

  async suspend(id: string, actor: AuditActor, notes?: string): Promise<RiderDetailsDto> {
    return this.setStatus(id, 'SUSPENDED', actor, 'Rider Account Suspended', notes, 'suspension');
  }

  async block(id: string, actor: AuditActor, notes?: string): Promise<RiderDetailsDto> {
    return this.setStatus(id, 'DEACTIVATED', actor, 'Rider Account Blocked', notes, 'blocked');
  }

  async activate(id: string, actor: AuditActor, notes?: string): Promise<RiderDetailsDto> {
    return this.setStatus(id, 'ACTIVE', actor, 'Rider Account Activated', notes);
  }

  /// Status, session revocation and audit row commit together. The user row is locked
  /// before its status is read, so concurrent requests cannot both log one transition.
  private async setStatus(
    id: string,
    status: UserStatus,
    actor: AuditActor,
    summary: string,
    notes?: string,
    logoutReason?: string,
  ): Promise<RiderDetailsDto> {
    if (!(await this.findRiderRow(id))) throw new RiderNotFoundError();
    const next = toRiderStatus(status);

    await this.databaseService.transactionManager.execute(async (tx) => {
      await this.userRepository.lockForUpdate(id, tx);
      const row = await tx.user.findUniqueOrThrow({ where: { id }, select: { status: true } });
      const current = toRiderStatus(row.status);
      if (current === next) {
        throw new RiderConflictError(`Rider is already ${current}`);
      }

      await this.userRepository.updateStatus(id, status, tx);
      const sessionsRevoked = logoutReason
        ? await this.sessionService.revokeAllInTransaction(id, logoutReason, tx)
        : 0;

      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'rider',
        entityId: id,
        summary,
        notes,
        before: { status: current, userStatus: row.status },
        after: { status: next, userStatus: status, sessionsRevoked },
        result: 'SUCCESS',
      });
    });

    // After commit, as `SessionService.logoutAll` does: retires the access tokens the
    // revoked sessions issued.
    if (logoutReason) await this.epochService.bump(id);
    return this.getById(id);
  }

  private async computeCancelStats(customerId: string): Promise<RiderRideStatsDto> {
    const [totalRides, completedRides, cancelledByCustomer, cancelledByDriver, noShows, fareSum] =
      await Promise.all([
        this.databaseService.client.ride.count({ where: { customerId } }),
        this.databaseService.client.ride.count({ where: { customerId, status: 'COMPLETED' } }),
        this.databaseService.client.ride.count({
          where: {
            customerId,
            cancellation: { cancelledBy: 'CUSTOMER' },
          },
        }),
        this.databaseService.client.ride.count({
          where: {
            customerId,
            cancellation: { cancelledBy: 'DRIVER' },
          },
        }),
        this.databaseService.client.ride.count({
          where: {
            customerId,
            cancellation: {
              OR: [
                { reasonCode: 'NO_SHOW' },
                { reasonCode: 'CUSTOMER_NO_SHOW' },
                { reasonCode: 'RIDER_NO_SHOW' },
              ],
            },
          },
        }),
        this.databaseService.client.rideFare.aggregate({
          _sum: { totalFare: true },
          where: { ride: { customerId, status: 'COMPLETED' } },
        }),
      ]);
    const cancelRate = totalRides === 0 ? 0 : Math.round((cancelledByCustomer / totalRides) * 100);
    return {
      totalRides,
      completedRides,
      cancelledByCustomer,
      cancelledByDriver,
      totalSpent: Number(fareSum._sum.totalFare ?? 0),
      cancelRate,
      noShowCount: noShows,
    };
  }

  private riderWhere(query: ListRidersQuery) {
    const statusFilter = statusesForFilter(query.status);
    const riderFilter = {
      deletedAt: null,
      roleAssignments: {
        some: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          role: { slug: 'customer' },
        },
        none: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          role: { slug: { notIn: ['customer', 'driver'] } },
        },
      },
      ...(statusFilter ? { status: { in: statusFilter } } : {}),
    };

    if (!query.search) return riderFilter;
    return {
      AND: [
        riderFilter,
        {
          OR: [
            { phoneNumber: { contains: query.search } },
            { email: { contains: query.search, mode: 'insensitive' as const } },
            { profile: { firstName: { contains: query.search, mode: 'insensitive' as const } } },
            { profile: { lastName: { contains: query.search, mode: 'insensitive' as const } } },
          ],
        },
      ],
    };
  }

  private async findRiderRow(id: string): Promise<RiderListRow | null> {
    const row = await this.databaseService.client.user.findFirst({
      where: {
        id,
        deletedAt: null,
        roleAssignments: {
          some: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            role: { slug: 'customer' },
          },
          none: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            role: { slug: { notIn: ['customer', 'driver'] } },
          },
        },
      },
      include: {
        profile: true,
        customerWallet: true,
        customerRatingAggregate: true,
        emergencyContacts: { orderBy: { priority: 'asc' }, take: 10 },
        _count: { select: { customerRides: true } },
      },
    });
    return row as RiderListRow | null;
  }

  private toListDto(row: RiderListRow): RiderListItemDto {
    return {
      id: row.id,
      riderId: riderDisplayId(row.id),
      fullName: displayName(row.profile, row.phoneNumber),
      mobileNumber: row.phoneNumber,
      ...(row.email ? { email: row.email } : {}),
      ...(row.profile?.gender ? { gender: row.profile.gender } : {}),
      ...(row.profile?.dateOfBirth
        ? { dateOfBirth: row.profile.dateOfBirth.toISOString().slice(0, 10) }
        : {}),
      riderStatus: toRiderStatus(row.status),
      ratingAvg:
        row.customerRatingAggregate && row.customerRatingAggregate.totalRatings > 0
          ? Number(row.customerRatingAggregate.avgRating)
          : row.customerRatingAggregate
            ? Number(row.customerRatingAggregate.avgRating) || 5
            : 5,
      totalRides: row._count.customerRides,
      walletBalance: row.customerWallet ? Number(row.customerWallet.balance) : 0,
      joinedAt: row.createdAt.toISOString(),
      ...(row.lastLoginAt ? { lastActiveAt: row.lastLoginAt.toISOString() } : {}),
      emergencyContacts: row.emergencyContacts.map((contact) => ({
        name: contact.contactName,
        phone: contact.phoneNumber,
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
