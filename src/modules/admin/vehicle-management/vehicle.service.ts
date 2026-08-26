import { DatabaseService } from '@core/database';
import { AdminVehicleNotFoundError } from './vehicle.errors.js';
import type { ListVehiclesQuery } from './vehicle.schemas.js';

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

function docExpiry(
  documents: Array<{ documentType: string; documentNumber: string | null; expiresAt: Date | null }>,
  type: string,
): { no?: string; expiry?: string } {
  const doc = documents.find((row) => row.documentType.toUpperCase() === type);
  if (!doc) return {};
  return {
    ...(doc.documentNumber ? { no: doc.documentNumber } : {}),
    ...(doc.expiresAt ? { expiry: doc.expiresAt.toISOString().slice(0, 10) } : {}),
  };
}

export interface VehicleListItemDto {
  id: string;
  driverId: string;
  driverName: string;
  registrationPlate: string;
  vehicleType: string;
  vehicleCategory?: string;
  brand?: string;
  model?: string;
  color?: string;
  manufacturingYear?: number;
  insuranceExpiry?: string;
  permitExpiry?: string;
  fitnessExpiry?: string;
  pollutionExpiry?: string;
  isActive: boolean;
  verificationStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface VehicleDetailsDto extends VehicleListItemDto {
  seatsCapacity: number;
  rcNumber?: string;
  insuranceNo?: string;
  permitNo?: string;
  pollutionNo?: string;
  fitnessNo?: string;
  renewalFlaggedAt?: string;
  documents: Array<{
    id: string;
    docType: string;
    docNumber?: string;
    fileUrl: string;
    expiryDate?: string;
    verifyStatus: string;
    comment?: string;
  }>;
  vehicle: {
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
  driver: {
    id: string;
    applicationId: string;
    driverName: string;
    mobileNumber: string;
    email?: string;
    vehicleType: string;
    registrationPlate?: string;
    driverStatus: string;
    ratingAvg: number;
    totalTrips: number;
    walletBalance: number;
    profilePhotoUrl?: string;
    joinedAt: string;
    isOnline: boolean;
    createdAt: string;
    updatedAt: string;
  };
}

export class AdminVehicleService {
  constructor(private readonly databaseService: DatabaseService) {}

  async list(query: ListVehiclesQuery): Promise<{
    data: VehicleListItemDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const skip = (query.page - 1) * query.limit;
    const where = this.vehicleWhere(query);
    const [rows, totalCount] = await Promise.all([
      this.databaseService.client.vehicle.findMany({
        where: where as never,
        include: {
          vehicleType: true,
          documents: true,
          assignments: {
            where: { status: 'ACTIVE', releasedAt: null },
            take: 1,
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
        orderBy: { createdAt: 'desc' },
        skip,
        take: query.limit,
      }),
      this.databaseService.client.vehicle.count({ where: where as never }),
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

  async getById(id: string): Promise<VehicleDetailsDto> {
    const row = await this.findVehicleRow(id);
    if (!row) throw new AdminVehicleNotFoundError();
    return this.toDetailsDto(row);
  }

  async flagForRenewal(id: string, actorId: string, notes?: string): Promise<VehicleDetailsDto> {
    const row = await this.findVehicleRow(id);
    if (!row) throw new AdminVehicleNotFoundError();

    const reason = notes?.trim() || 'Flagged for document renewal';
    await this.databaseService.client.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id },
        data: {
          verificationStatus: 'PENDING',
          verifiedAt: null,
          verifiedBy: null,
          rejectionReason: reason,
        },
      });
      await tx.vehicleDocument.updateMany({
        where: { vehicleId: id },
        data: {
          verificationStatus: 'PENDING',
          verifiedAt: null,
          verifiedBy: null,
          rejectionReason: reason,
        },
      });
      await tx.adminActivityLog.create({
        data: {
          actorId,
          action: 'UPDATE',
          entityType: 'vehicle',
          entityId: id,
          summary: 'Vehicle Flagged for Renewal',
          metadata: {
            registrationPlate: row.registrationNumber,
            ...(notes ? { notes } : {}),
          },
        },
      });
    });

    return this.getById(id);
  }

  private vehicleWhere(query: ListVehiclesQuery) {
    if (!query.search) return {};
    return {
      OR: [
        { registrationNumber: { contains: query.search, mode: 'insensitive' as const } },
        { make: { contains: query.search, mode: 'insensitive' as const } },
        { model: { contains: query.search, mode: 'insensitive' as const } },
        {
          assignments: {
            some: {
              status: 'ACTIVE',
              releasedAt: null,
              driver: {
                OR: [
                  {
                    profile: {
                      fullLegalName: { contains: query.search, mode: 'insensitive' as const },
                    },
                  },
                  { user: { phoneNumber: { contains: query.search } } },
                ],
              },
            },
          },
        },
      ],
    };
  }

  private async findVehicleRow(id: string) {
    return this.databaseService.client.vehicle.findFirst({
      where: { id },
      include: {
        vehicleType: true,
        documents: { orderBy: { createdAt: 'asc' } },
        assignments: {
          where: { status: 'ACTIVE', releasedAt: null },
          take: 1,
          include: {
            driver: {
              include: {
                profile: true,
                wallet: true,
                onlineStatus: true,
                user: { include: { profile: true } },
              },
            },
          },
        },
      },
    });
  }

  private toListDto(
    row: NonNullable<Awaited<ReturnType<AdminVehicleService['findVehicleRow']>>>,
  ): VehicleListItemDto {
    const assignment = row.assignments[0];
    const driver = assignment?.driver;
    const insurance = docExpiry(row.documents, 'INSURANCE');
    const permit = docExpiry(row.documents, 'PERMIT');
    const fitness = docExpiry(row.documents, 'FITNESS');
    const puc = docExpiry(row.documents, 'PUC');
    const pollution = puc.expiry || puc.no ? puc : docExpiry(row.documents, 'POLLUTION');

    return {
      id: row.id,
      driverId: driver?.id ?? '',
      driverName: driver
        ? displayName(driver.profile, driver.user.profile, driver.user.phoneNumber)
        : (row.ownerName ?? 'Unassigned'),
      registrationPlate: row.registrationNumber,
      vehicleType: mapVehicleTypeLabel(row.vehicleType?.code, row.vehicleType?.name),
      ...(row.vehicleType?.name ? { vehicleCategory: row.vehicleType.name } : {}),
      ...(row.make ? { brand: row.make } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.color ? { color: row.color } : {}),
      ...(row.manufacturingYear ? { manufacturingYear: row.manufacturingYear } : {}),
      ...(insurance.expiry ? { insuranceExpiry: insurance.expiry } : {}),
      ...(permit.expiry ? { permitExpiry: permit.expiry } : {}),
      ...(fitness.expiry ? { fitnessExpiry: fitness.expiry } : {}),
      ...(pollution.expiry ? { pollutionExpiry: pollution.expiry } : {}),
      isActive: row.isActive && row.verificationStatus === 'VERIFIED',
      verificationStatus: row.verificationStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDetailsDto(
    row: NonNullable<Awaited<ReturnType<AdminVehicleService['findVehicleRow']>>>,
  ): VehicleDetailsDto {
    const base = this.toListDto(row);
    const assignment = row.assignments[0];
    const driver = assignment?.driver;
    const insurance = docExpiry(row.documents, 'INSURANCE');
    const permit = docExpiry(row.documents, 'PERMIT');
    const fitness = docExpiry(row.documents, 'FITNESS');
    const puc = docExpiry(row.documents, 'PUC');
    const pollution = puc.expiry || puc.no ? puc : docExpiry(row.documents, 'POLLUTION');
    const rc = docExpiry(row.documents, 'RC');
    const renewalFlagged =
      row.verificationStatus === 'PENDING' && row.rejectionReason?.toLowerCase().includes('renewal')
        ? row.updatedAt.toISOString()
        : undefined;

    const vehicleInfo = {
      id: row.id,
      driverId: driver?.id ?? '',
      vehicleType: base.vehicleType,
      ...(base.vehicleCategory ? { vehicleCategory: base.vehicleCategory } : {}),
      ...(row.make ? { brand: row.make } : {}),
      ...(row.model ? { model: row.model } : {}),
      registrationPlate: row.registrationNumber,
      ...(row.color ? { color: row.color } : {}),
      seatsCapacity: row.seatingCapacity ?? 4,
      ...(row.manufacturingYear ? { manufacturingYear: row.manufacturingYear } : {}),
      ...(rc.no ? { rcNumber: rc.no } : {}),
      ...(insurance.no ? { insuranceNo: insurance.no } : {}),
      ...(insurance.expiry ? { insuranceExpiry: insurance.expiry } : {}),
      ...(permit.no ? { permitNo: permit.no } : {}),
      ...(permit.expiry ? { permitExpiry: permit.expiry } : {}),
      ...(pollution.no ? { pollutionNo: pollution.no } : {}),
      ...(pollution.expiry ? { pollutionExpiry: pollution.expiry } : {}),
      ...(fitness.no ? { fitnessNo: fitness.no } : {}),
      ...(fitness.expiry ? { fitnessExpiry: fitness.expiry } : {}),
    };

    return {
      ...base,
      seatsCapacity: row.seatingCapacity ?? 4,
      ...(rc.no ? { rcNumber: rc.no } : {}),
      ...(insurance.no ? { insuranceNo: insurance.no } : {}),
      ...(permit.no ? { permitNo: permit.no } : {}),
      ...(pollution.no ? { pollutionNo: pollution.no } : {}),
      ...(fitness.no ? { fitnessNo: fitness.no } : {}),
      ...(renewalFlagged ? { renewalFlaggedAt: renewalFlagged } : {}),
      documents: row.documents.map((doc) => ({
        id: doc.id,
        docType: doc.documentType.toLowerCase(),
        ...(doc.documentNumber ? { docNumber: doc.documentNumber } : {}),
        fileUrl: doc.fileUrl ?? '',
        ...(doc.expiresAt ? { expiryDate: doc.expiresAt.toISOString().slice(0, 10) } : {}),
        verifyStatus:
          doc.verificationStatus === 'VERIFIED'
            ? 'approved'
            : doc.verificationStatus === 'REJECTED'
              ? 'rejected'
              : 'pending',
        ...(doc.rejectionReason ? { comment: doc.rejectionReason } : {}),
      })),
      vehicle: vehicleInfo,
      driver: {
        id: driver?.id ?? '',
        applicationId: driver?.id ?? '',
        driverName: base.driverName,
        mobileNumber: driver?.user.phoneNumber ?? row.ownerPhone ?? '',
        ...(driver?.user.email ? { email: driver.user.email } : {}),
        vehicleType: base.vehicleType,
        registrationPlate: row.registrationNumber,
        driverStatus: driver?.isSuspended ? 'suspended' : 'active',
        ratingAvg: driver ? Number(driver.rating) : 0,
        totalTrips: driver?.totalRides ?? 0,
        walletBalance: driver?.wallet ? Number(driver.wallet.balance) : 0,
        ...(driver?.profile?.profilePhoto ? { profilePhotoUrl: driver.profile.profilePhoto } : {}),
        joinedAt: driver?.createdAt.toISOString() ?? row.createdAt.toISOString(),
        isOnline:
          driver?.onlineStatus?.status === 'ONLINE' ||
          driver?.onlineStatus?.status === 'ON_TRIP' ||
          driver?.onlineStatus?.status === 'BUSY',
        createdAt: driver?.createdAt.toISOString() ?? row.createdAt.toISOString(),
        updatedAt: driver?.updatedAt.toISOString() ?? row.updatedAt.toISOString(),
      },
    };
  }
}
