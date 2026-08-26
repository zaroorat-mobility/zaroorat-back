import { DatabaseService } from '@core/database';
import type { UserStatus } from '@core/database/types';
import { SessionService } from '@modules/auth/services/session/session.service.js';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { RiderConflictError, RiderNotFoundError } from './rider.errors.js';
import type { ListRidersQuery, RiderStatusDto } from './rider.schemas.js';

type RiderListRow = {
  id: string;
  phoneNumber: string;
  email: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  profile: {
    firstName: string | null;
    lastName: string | null;
    gender: string | null;
    dateOfBirth: Date | null;
  } | null;
  customerWallet: { balance: { toString(): string } } | null;
  customerRatingAggregate: { avgRating: { toString(): string } } | null;
  emergencyContacts: Array<{ contactName: string; phoneNumber: string }>;
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

export interface RiderDetailsDto extends RiderListItemDto {
  country?: string;
  state?: string;
  city?: string;
  postcode?: string;
  addressLine1?: string;
  addressLine2?: string;
  preferredPaymentMethod?: 'cash' | 'upi' | 'card' | 'wallet';
  cancelRate: number;
  noShowCount: number;
  ledger: Array<{
    id: string;
    date: string;
    type: 'TOPUP' | 'PAYMENT' | 'REFUND' | 'CASHBACK';
    amount: number;
    balanceAfter: number;
    rideId?: string;
  }>;
  rideHistory: Array<{
    id: string;
    date: string;
    pickupAddress: string;
    dropAddress: string;
    fare: number;
    paymentMethod: string;
    status: string;
  }>;
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
  return `RID-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
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

    const [rides, walletTxns, activityLogs, paymentMethod, cancelStats] = await Promise.all([
      this.databaseService.client.ride.findMany({
        where: { customerId: id },
        include: { fare: true },
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
      rideHistory: rides.map((ride) => ({
        id: ride.rideCode,
        date: ride.createdAt.toISOString(),
        pickupAddress: ride.pickupAddress ?? '—',
        dropAddress: ride.dropAddress ?? '—',
        fare: ride.fare ? Number(ride.fare.totalFare) : 0,
        paymentMethod: ride.paymentMethod.toLowerCase(),
        status: ride.status.toLowerCase(),
      })),
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

  async suspend(id: string, actorId: string, notes?: string): Promise<RiderDetailsDto> {
    return this.setStatus(id, 'SUSPENDED', actorId, 'Rider Account Suspended', notes, 'suspension');
  }

  async block(id: string, actorId: string, notes?: string): Promise<RiderDetailsDto> {
    return this.setStatus(id, 'DEACTIVATED', actorId, 'Rider Account Blocked', notes, 'blocked');
  }

  async activate(id: string, actorId: string, notes?: string): Promise<RiderDetailsDto> {
    return this.setStatus(id, 'ACTIVE', actorId, 'Rider Account Activated', notes);
  }

  private async setStatus(
    id: string,
    status: UserStatus,
    actorId: string,
    summary: string,
    notes?: string,
    logoutReason?: string,
  ): Promise<RiderDetailsDto> {
    const row = await this.findRiderRow(id);
    if (!row) throw new RiderNotFoundError();

    const current = toRiderStatus(row.status);
    const next = toRiderStatus(status);
    if (current === next) {
      throw new RiderConflictError(`Rider is already ${current}`);
    }

    await this.userRepository.updateStatus(id, status);
    if (logoutReason) {
      await this.sessionService.logoutAll(id, logoutReason);
    }

    await this.databaseService.client.adminActivityLog.create({
      data: {
        actorId,
        action: 'UPDATE',
        entityType: 'rider',
        entityId: id,
        summary,
        metadata: {
          fromStatus: current,
          toStatus: next,
          ...(notes ? { notes } : {}),
        },
      },
    });

    return this.getById(id);
  }

  private async computeCancelStats(customerId: string): Promise<{
    cancelRate: number;
    noShowCount: number;
  }> {
    const [totalRides, cancelledByCustomer, noShows] = await Promise.all([
      this.databaseService.client.ride.count({ where: { customerId } }),
      this.databaseService.client.ride.count({
        where: {
          customerId,
          cancellation: { cancelledBy: 'CUSTOMER' },
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
    ]);
    const cancelRate = totalRides === 0 ? 0 : Math.round((cancelledByCustomer / totalRides) * 100);
    return { cancelRate, noShowCount: noShows };
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
        emergencyContacts: { orderBy: { priority: 'asc' }, take: 5 },
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
      ratingAvg: row.customerRatingAggregate ? Number(row.customerRatingAggregate.avgRating) : 5,
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
