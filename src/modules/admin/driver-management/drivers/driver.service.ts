import { DatabaseService } from '@core/database';
import type { UserStatus } from '@core/database/types';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { SessionService } from '@modules/auth/services/session/session.service.js';
import { DriverService } from '@modules/drivers/services/driver.service.js';
import { AdminDriverConflictError, AdminDriverNotFoundError } from '../driver.errors.js';
import type { ListDriversQuery } from './driver.schemas.js';

export type DriverStatusDto =
  'active' | 'offline' | 'online' | 'on_trip' | 'suspended' | 'blocked' | 'pending' | 'rejected';

export interface DriverListItemDto {
  id: string;
  driverCode: string;
  applicationId: string;
  driverName: string;
  mobileNumber: string;
  email?: string;
  vehicleType: string;
  registrationPlate?: string;
  driverStatus: DriverStatusDto;
  verificationStatus: string;
  ratingAvg: number;
  totalTrips: number;
  walletBalance: number;
  profilePhotoUrl?: string;
  joinedAt: string;
  lastActiveAt?: string;
  isOnline: boolean;
  isSuspended: boolean;
  isBlocked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DriverDetailsDto extends DriverListItemDto {
  gender?: string;
  dateOfBirth?: string;
  preferredLanguage?: string;
  country?: string;
  state?: string;
  city?: string;
  postcode?: string;
  addressLine1?: string;
  documents: Array<{
    id: string;
    driverId: string;
    docType: string;
    docNumber?: string;
    fileUrl: string;
    expiryDate?: string;
    verifyStatus: string;
    comment?: string;
    verifiedAt?: string;
  }>;
  vehicle?: {
    id: string;
    driverId: string;
    vehicleType: string;
    vehicleCategory?: string;
    brand?: string;
    model?: string;
    registrationPlate: string;
    color?: string;
    seatsCapacity: number;
    manufacturingYear?: number;
    rcNumber?: string;
    insuranceNo?: string;
    insuranceExpiry?: string;
    permitNo?: string;
    permitExpiry?: string;
    pollutionNo?: string;
    pollutionExpiry?: string;
    fitnessNo?: string;
    fitnessExpiry?: string;
  };
  bankAccounts: Array<{
    bankAccountName?: string;
    bankName?: string;
    bankIfsc?: string;
    upiId?: string;
    verificationStatus: string;
    isDefault: boolean;
  }>;
  ledger: Array<{
    id: string;
    date: string;
    type: string;
    amount: number;
    balanceAfter: number;
    rideId?: string;
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
  driverProfile: { fullLegalName: string | null } | null | undefined,
  userProfile: { firstName: string | null; lastName: string | null } | null | undefined,
  phone: string,
): string {
  if (driverProfile?.fullLegalName?.trim()) return driverProfile.fullLegalName.trim();
  const parts = [userProfile?.firstName, userProfile?.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return phone;
}

function mapDocStatus(status: string): string {
  if (status === 'VERIFIED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  return 'pending';
}

function vehicleDocFields(
  documents: Array<{ documentType: string; documentNumber: string | null; expiresAt: Date | null }>,
) {
  const pick = (type: string) => documents.find((doc) => doc.documentType.toUpperCase() === type);
  const insurance = pick('INSURANCE');
  const permit = pick('PERMIT');
  const fitness = pick('FITNESS');
  const pollution = pick('PUC') ?? pick('POLLUTION');
  const rc = pick('RC');
  return {
    ...(rc?.documentNumber ? { rcNumber: rc.documentNumber } : {}),
    ...(insurance?.documentNumber ? { insuranceNo: insurance.documentNumber } : {}),
    ...(insurance?.expiresAt
      ? { insuranceExpiry: insurance.expiresAt.toISOString().slice(0, 10) }
      : {}),
    ...(permit?.documentNumber ? { permitNo: permit.documentNumber } : {}),
    ...(permit?.expiresAt ? { permitExpiry: permit.expiresAt.toISOString().slice(0, 10) } : {}),
    ...(pollution?.documentNumber ? { pollutionNo: pollution.documentNumber } : {}),
    ...(pollution?.expiresAt
      ? { pollutionExpiry: pollution.expiresAt.toISOString().slice(0, 10) }
      : {}),
    ...(fitness?.documentNumber ? { fitnessNo: fitness.documentNumber } : {}),
    ...(fitness?.expiresAt ? { fitnessExpiry: fitness.expiresAt.toISOString().slice(0, 10) } : {}),
  };
}

function mapVehicleTypeLabel(
  code: string | null | undefined,
  name: string | null | undefined,
): string {
  const raw = (code ?? name ?? 'cab').toLowerCase();
  if (raw.includes('auto')) return 'auto';
  if (raw.includes('bike') || raw.includes('scooter')) return 'bike';
  if (raw.includes('pool') || raw.includes('share')) return 'carpool';
  return 'cab';
}

export class AdminDriverService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly driverService: DriverService,
    private readonly userRepository: UserRepository,
    private readonly sessionService: SessionService,
  ) {}

  async list(query: ListDriversQuery): Promise<{
    data: DriverListItemDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const skip = (query.page - 1) * query.limit;
    const where = this.driverWhere(query);
    const [rows, totalCount] = await Promise.all([
      this.databaseService.client.driver.findMany({
        where: where as never,
        include: {
          profile: true,
          wallet: true,
          onlineStatus: true,
          user: { include: { profile: true } },
          assignments: {
            where: { status: 'ACTIVE', releasedAt: null },
            take: 1,
            include: { vehicle: { include: { vehicleType: true, documents: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
      }),
      this.databaseService.client.driver.count({ where: where as never }),
    ]);

    const data = rows.map((row) => this.toListDto(row as never));
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

  async getById(id: string): Promise<DriverDetailsDto> {
    const row = await this.findDriverRow(id);
    if (!row) throw new AdminDriverNotFoundError();

    const [walletTxns, activityLogs] = await Promise.all([
      this.databaseService.client.driverWalletTransaction.findMany({
        where: { driverId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.databaseService.client.adminActivityLog.findMany({
        where: { entityType: 'driver', entityId: id },
        include: { actor: { include: { profile: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const base = this.toListDto(row);
    const assignment = row.assignments[0];
    const vehicle = assignment?.vehicle;

    const timeline = [
      {
        id: `created-${row.id}`,
        action: 'Driver Profile Created',
        actor: 'System',
        timestamp: row.createdAt.toISOString(),
        isSystem: true as const,
      },
      ...activityLogs.map((log) => {
        const actorName = log.actor
          ? displayName(null, log.actor.profile, log.actor.phoneNumber)
          : 'System';
        const notes = extractNotes(log.metadata) ?? log.summary ?? undefined;
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

    return {
      ...base,
      ...(row.profile?.gender ? { gender: row.profile.gender } : {}),
      ...(row.profile?.dateOfBirth
        ? { dateOfBirth: row.profile.dateOfBirth.toISOString().slice(0, 10) }
        : {}),
      ...(row.profile?.preferredLanguage
        ? { preferredLanguage: row.profile.preferredLanguage }
        : {}),
      ...(row.profile?.country ? { country: row.profile.country } : {}),
      ...(row.profile?.state ? { state: row.profile.state } : {}),
      ...(row.profile?.city ? { city: row.profile.city } : {}),
      ...(row.profile?.postalCode ? { postcode: row.profile.postalCode } : {}),
      ...(row.profile?.addressLine ? { addressLine1: row.profile.addressLine } : {}),
      documents: row.documents.map((doc) => {
        const comment = doc.rejectionReason ?? doc.verificationNotes ?? undefined;
        return {
          id: doc.id,
          driverId: doc.driverId,
          docType: doc.documentType.toLowerCase(),
          ...(doc.documentNumber ? { docNumber: doc.documentNumber } : {}),
          fileUrl: doc.fileUrl ?? '',
          ...(doc.fileId ? { fileId: doc.fileId } : {}),
          ...(doc.expiresAt ? { expiryDate: doc.expiresAt.toISOString().slice(0, 10) } : {}),
          verifyStatus: mapDocStatus(doc.verificationStatus),
          ...(comment ? { comment } : {}),
          ...(doc.verifiedAt ? { verifiedAt: doc.verifiedAt.toISOString() } : {}),
        };
      }),
      ...(vehicle
        ? {
            vehicle: {
              id: vehicle.id,
              driverId: row.id,
              vehicleType: mapVehicleTypeLabel(
                vehicle.vehicleType?.code,
                vehicle.vehicleType?.name,
              ),
              ...(vehicle.vehicleType?.name ? { vehicleCategory: vehicle.vehicleType.name } : {}),
              ...(vehicle.make ? { brand: vehicle.make } : {}),
              ...(vehicle.model ? { model: vehicle.model } : {}),
              registrationPlate: vehicle.registrationNumber,
              ...(vehicle.color ? { color: vehicle.color } : {}),
              seatsCapacity: vehicle.seatingCapacity ?? 4,
              ...(vehicle.manufacturingYear
                ? { manufacturingYear: vehicle.manufacturingYear }
                : {}),
              ...vehicleDocFields(vehicle.documents ?? []),
            },
          }
        : {}),
      bankAccounts: row.bankAccounts.map((account) => ({
        ...(account.accountHolderName ? { bankAccountName: account.accountHolderName } : {}),
        ...(account.bankName ? { bankName: account.bankName } : {}),
        ...(account.ifscCode ? { bankIfsc: account.ifscCode } : {}),
        ...(account.upiId ? { upiId: account.upiId } : {}),
        verificationStatus: account.verificationStatus,
        isDefault: account.isDefault,
      })),
      ledger: walletTxns.map((txn) => ({
        id: txn.id,
        date: txn.createdAt.toISOString(),
        type: String(txn.txnType),
        amount: Number(txn.amount),
        balanceAfter: Number(txn.balanceAfter),
        ...(txn.referenceType === 'ride' && txn.referenceId ? { rideId: txn.referenceId } : {}),
      })),
      timeline,
      auditLogs: activityLogs.map((log) => {
        const operator = log.actor
          ? displayName(null, log.actor.profile, log.actor.phoneNumber)
          : 'System';
        const notes = extractNotes(log.metadata);
        return {
          action: log.summary ?? log.action,
          operator,
          timestamp: log.createdAt.toISOString(),
          ...(notes ? { notes } : {}),
        };
      }),
    };
  }

  async suspend(id: string, actorId: string, notes?: string): Promise<DriverDetailsDto> {
    return this.setModerationState(id, 'suspended', actorId, 'Driver Account Suspended', notes);
  }

  async block(id: string, actorId: string, notes?: string): Promise<DriverDetailsDto> {
    return this.setModerationState(id, 'blocked', actorId, 'Driver Account Blocked', notes);
  }

  async activate(id: string, actorId: string, notes?: string): Promise<DriverDetailsDto> {
    return this.setModerationState(id, 'active', actorId, 'Driver Account Activated', notes);
  }

  async setSuspendedState(
    id: string,
    isSuspended: boolean,
    actorId: string,
    notes?: string,
  ): Promise<DriverDetailsDto> {
    return this.setModerationState(
      id,
      isSuspended ? 'suspended' : 'active',
      actorId,
      isSuspended ? 'Driver Account Suspended' : 'Driver Account Activated',
      notes,
    );
  }

  private async setModerationState(
    id: string,
    next: 'suspended' | 'blocked' | 'active',
    actorId: string,
    summary: string,
    notes?: string,
  ): Promise<DriverDetailsDto> {
    const row = await this.findDriverRow(id);
    if (!row) throw new AdminDriverNotFoundError();

    const current = toDriverStatus(
      row.isSuspended,
      row.user.status,
      row.verificationStatus,
      row.onlineStatus?.status,
    );
    const currentGate =
      current === 'blocked'
        ? 'blocked'
        : row.isSuspended || current === 'suspended'
          ? 'suspended'
          : 'active';

    if (currentGate === next) {
      throw new AdminDriverConflictError(`Driver is already ${next}`);
    }
    if (next === 'suspended' && currentGate === 'blocked') {
      throw new AdminDriverConflictError('Driver is already blocked');
    }

    const shouldSuspend = next !== 'active';
    if (row.isSuspended !== shouldSuspend) {
      await this.driverService.status.setSuspended(id, shouldSuspend);
    }

    const nextUserStatus: UserStatus =
      next === 'blocked' ? 'DEACTIVATED' : next === 'suspended' ? 'SUSPENDED' : 'ACTIVE';
    if (row.user.status !== nextUserStatus) {
      await this.userRepository.updateStatus(row.userId, nextUserStatus);
    }

    if (shouldSuspend) {
      await this.sessionService.logoutAll(
        row.userId,
        next === 'blocked' ? 'blocked' : 'suspension',
      );
    }

    await this.databaseService.client.adminActivityLog.create({
      data: {
        actorId,
        action: 'UPDATE',
        entityType: 'driver',
        entityId: id,
        summary,
        metadata: {
          fromStatus: currentGate,
          toStatus: next,
          isSuspended: shouldSuspend,
          userStatus: nextUserStatus,
          ...(notes ? { notes } : {}),
        },
      },
    });

    return this.getById(id);
  }

  private driverWhere(query: ListDriversQuery) {
    const status = query.status ?? 'all';
    let statusFilter: Record<string, unknown> = {};
    if (status === 'blocked') {
      statusFilter = { user: { status: 'DEACTIVATED' } };
    } else if (status === 'suspended') {
      statusFilter = {
        isSuspended: true,
        user: { status: { not: 'DEACTIVATED' } },
      };
    } else if (status === 'pending') {
      statusFilter = {
        isSuspended: false,
        verificationStatus: { in: ['PENDING', 'DOCUMENT_REVIEW'] },
        user: { status: { not: 'DEACTIVATED' } },
      };
    } else if (status === 'rejected') {
      statusFilter = {
        isSuspended: false,
        verificationStatus: 'REJECTED',
        user: { status: { not: 'DEACTIVATED' } },
      };
    } else if (status === 'active') {
      statusFilter = {
        isSuspended: false,
        verificationStatus: 'VERIFIED',
        user: { status: { not: 'DEACTIVATED' } },
      };
    } else if (status === 'online') {
      statusFilter = {
        isSuspended: false,
        user: { status: { not: 'DEACTIVATED' } },
        onlineStatus: { status: { in: ['ONLINE', 'ON_TRIP', 'BUSY'] } },
      };
    } else if (status === 'offline') {
      statusFilter = {
        isSuspended: false,
        user: { status: { not: 'DEACTIVATED' } },
        OR: [{ onlineStatus: null }, { onlineStatus: { status: { in: ['OFFLINE', 'BREAK'] } } }],
      };
    }

    const base = {
      deletedAt: null,
      ...statusFilter,
    };

    if (!query.search) return base;
    return {
      AND: [
        base,
        {
          OR: [
            { driverCode: { contains: query.search, mode: 'insensitive' as const } },
            { user: { phoneNumber: { contains: query.search } } },
            { user: { email: { contains: query.search, mode: 'insensitive' as const } } },
            {
              profile: {
                fullLegalName: { contains: query.search, mode: 'insensitive' as const },
              },
            },
            {
              user: {
                profile: {
                  firstName: { contains: query.search, mode: 'insensitive' as const },
                },
              },
            },
            {
              user: {
                profile: {
                  lastName: { contains: query.search, mode: 'insensitive' as const },
                },
              },
            },
          ],
        },
      ],
    };
  }

  private async findDriverRow(id: string) {
    return this.databaseService.client.driver.findFirst({
      where: { id, deletedAt: null },
      include: {
        profile: true,
        wallet: true,
        onlineStatus: true,
        documents: { orderBy: { createdAt: 'asc' } },
        bankAccounts: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] },
        user: { include: { profile: true } },
        assignments: {
          where: { status: 'ACTIVE', releasedAt: null },
          take: 1,
          include: { vehicle: { include: { vehicleType: true, documents: true } } },
        },
      },
    });
  }

  private toListDto(
    row: NonNullable<Awaited<ReturnType<AdminDriverService['findDriverRow']>>>,
  ): DriverListItemDto {
    const assignment = row.assignments[0];
    const vehicle = assignment?.vehicle;
    const online = row.onlineStatus?.status;
    const driverStatus = toDriverStatus(
      row.isSuspended,
      row.user.status,
      row.verificationStatus,
      online,
    );
    const name = displayName(row.profile, row.user.profile, row.user.phoneNumber);
    const isBlocked = row.user.status === 'DEACTIVATED';

    return {
      id: row.id,
      driverCode: row.driverCode,
      applicationId: row.id,
      driverName: name,
      mobileNumber: row.user.phoneNumber,
      ...(row.user.email ? { email: row.user.email } : {}),
      vehicleType: mapVehicleTypeLabel(vehicle?.vehicleType?.code, vehicle?.vehicleType?.name),
      ...(vehicle?.registrationNumber ? { registrationPlate: vehicle.registrationNumber } : {}),
      driverStatus,
      verificationStatus: row.verificationStatus,
      ratingAvg: Number(row.rating),
      totalTrips: row.totalRides,
      walletBalance: row.wallet ? Number(row.wallet.balance) : 0,
      ...(row.profile?.profilePhoto ? { profilePhotoUrl: row.profile.profilePhoto } : {}),
      joinedAt: row.createdAt.toISOString(),
      ...(row.lastRideAt ? { lastActiveAt: row.lastRideAt.toISOString() } : {}),
      isOnline: !isBlocked && (online === 'ONLINE' || online === 'ON_TRIP' || online === 'BUSY'),
      isSuspended: row.isSuspended && !isBlocked,
      isBlocked,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function toDriverStatus(
  isSuspended: boolean,
  userStatus: string,
  verificationStatus: string,
  online: string | null | undefined,
): DriverStatusDto {
  if (userStatus === 'DEACTIVATED') return 'blocked';
  if (isSuspended || userStatus === 'SUSPENDED') return 'suspended';
  if (verificationStatus === 'REJECTED') return 'rejected';
  if (verificationStatus === 'PENDING' || verificationStatus === 'DOCUMENT_REVIEW') {
    return 'pending';
  }
  if (online === 'ON_TRIP' || online === 'BUSY') return 'on_trip';
  if (online === 'ONLINE') return 'online';
  if (verificationStatus === 'VERIFIED')
    return online === 'OFFLINE' || !online ? 'offline' : 'active';
  return 'active';
}

function extractNotes(metadata: unknown): string | undefined {
  if (
    metadata &&
    typeof metadata === 'object' &&
    metadata !== null &&
    'notes' in metadata &&
    typeof (metadata as { notes?: unknown }).notes === 'string'
  ) {
    return (metadata as { notes: string }).notes;
  }
  return undefined;
}
