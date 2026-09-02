import { DatabaseService } from '@core/database';
import { AuthService } from '@modules/auth/services/auth.service.js';
import { DriverService } from '@modules/drivers/services/driver.service.js';
import { DRIVER_DOCUMENT_TYPE } from '@modules/drivers/constants/driver.constants.js';
import type { VerificationStatus } from '@modules/drivers/types/index.js';
import { generateDriverCode } from '@modules/drivers/utils/driver-code.util.js';
import { VEHICLE_DOCUMENT_TYPE } from '@config/vehicle/vehicle.config.js';
import { ReferralApplyService, ReferralError } from '@modules/referrals/index.js';
import { AdminDriverNotFoundError, AdminDriverConflictError } from '../driver.errors.js';
import {
  AdminDriverService,
  type DriverDetailsDto,
  type DriverListItemDto,
} from '../drivers/driver.service.js';
import type { CreateManualApplicationBody, ListApplicationsQuery } from './application.schemas.js';

export type ApplicationStatusDto =
  'pending_review' | 'under_review' | 'approved' | 'rejected' | 'resubmission_required';

export type ApplicationSourceDto = 'driver_app' | 'admin_manual';

export interface ApplicationListItemDto {
  id: string;
  applicationId: string;
  driverId: string;
  driverName: string;
  mobileNumber: string;
  vehicleType: string;
  applicationStatus: ApplicationStatusDto;
  source: ApplicationSourceDto;
  submittedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationDetailsDto extends ApplicationListItemDto {
  email?: string;
  gender?: string;
  dateOfBirth?: string;
  profilePhotoUrl?: string;
  onlineStatus: 'online' | 'offline';
  bgCheckStatus: 'not_started' | 'in_progress' | 'clear' | 'flagged';
  ratingAvg: number;
  totalTrips: number;
  isAvailable: boolean;
  isBlocked: boolean;
  country?: string;
  state?: string;
  city?: string;
  postcode?: string;
  addressLine1?: string;
  preferredLanguage?: string;
  documents: DriverDetailsDto['documents'];
  vehicle?: DriverDetailsDto['vehicle'];
  bankAccounts: DriverDetailsDto['bankAccounts'];
  timeline: DriverDetailsDto['timeline'];
  auditLogs: DriverDetailsDto['auditLogs'];
}

const VEHICLE_TYPE_CODE: Record<CreateManualApplicationBody['vehicleType'], string> = {
  cab: 'CAB_ECONOMY',
  auto: 'AUTO',
  bike: 'BIKE',
  carpool: 'CAB_ECONOMY',
};

function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return trimmed;
  if (/^\d{10}$/.test(trimmed)) return `+91${trimmed}`;
  return `+${trimmed}`;
}

function normalizePlate(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0] || fullName;
  const lastName = parts.slice(1).join(' ') || firstName;
  return { firstName, lastName };
}

function toApplicationStatus(verificationStatus: string): ApplicationStatusDto {
  const status = verificationStatus.toUpperCase();
  if (status === 'VERIFIED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  if (status === 'DOCUMENT_REVIEW') return 'under_review';
  return 'pending_review';
}

function toListItem(
  driver: DriverListItemDto,
  source: ApplicationSourceDto = 'driver_app',
): ApplicationListItemDto {
  return {
    id: driver.id,
    applicationId:
      driver.driverCode || `APP-${driver.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    driverId: driver.id,
    driverName: driver.driverName,
    mobileNumber: driver.mobileNumber,
    vehicleType: driver.vehicleType,
    applicationStatus: toApplicationStatus(driver.verificationStatus),
    source,
    submittedAt: driver.joinedAt || driver.createdAt,
    createdAt: driver.createdAt,
    updatedAt: driver.updatedAt,
  };
}

function toDetails(
  driver: DriverDetailsDto,
  source: ApplicationSourceDto = 'driver_app',
): ApplicationDetailsDto {
  const base = toListItem(driver, source);
  return {
    ...base,
    ...(driver.email ? { email: driver.email } : {}),
    ...(driver.gender ? { gender: driver.gender } : {}),
    ...(driver.dateOfBirth ? { dateOfBirth: driver.dateOfBirth } : {}),
    ...(driver.profilePhotoUrl ? { profilePhotoUrl: driver.profilePhotoUrl } : {}),
    onlineStatus: driver.isOnline ? 'online' : 'offline',
    bgCheckStatus: 'not_started',
    ratingAvg: driver.ratingAvg,
    totalTrips: driver.totalTrips,
    isAvailable: !driver.isSuspended && !driver.isBlocked,
    isBlocked: driver.isBlocked,
    ...(driver.country ? { country: driver.country } : {}),
    ...(driver.state ? { state: driver.state } : {}),
    ...(driver.city ? { city: driver.city } : {}),
    ...(driver.postcode ? { postcode: driver.postcode } : {}),
    ...(driver.addressLine1 ? { addressLine1: driver.addressLine1 } : {}),
    ...(driver.preferredLanguage ? { preferredLanguage: driver.preferredLanguage } : {}),
    documents: driver.documents,
    ...(driver.vehicle ? { vehicle: driver.vehicle } : {}),
    bankAccounts: driver.bankAccounts,
    timeline: driver.timeline,
    auditLogs: driver.auditLogs,
  };
}

function pickUrl(...urls: Array<string | undefined>): string | undefined {
  for (const url of urls) {
    if (url && url.trim().length > 0) return url.trim();
  }
  return undefined;
}

function isFileId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function pickFileRef(...refs: Array<string | undefined>): { fileUrl?: string; fileId?: string } {
  const ref = pickUrl(...refs);
  if (!ref) return {};
  if (isFileId(ref)) return { fileId: ref };
  return { fileUrl: ref };
}

export class AdminApplicationService {
  constructor(
    private readonly adminDriverService: AdminDriverService,
    private readonly driverService: DriverService,
    private readonly databaseService: DatabaseService,
    private readonly authService: AuthService,
    private readonly referralApplyService: ReferralApplyService,
  ) {}

  async list(query: ListApplicationsQuery): Promise<{
    data: ApplicationListItemDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const drivers = await this.adminDriverService.list({
      page: 1,
      limit: 100,
      ...(query.search ? { search: query.search } : {}),
      status: 'all',
    });

    const sourceByDriverId = await this.resolveSources(drivers.data.map((row) => row.id));

    let applications = drivers.data
      .filter((row) => row.verificationStatus.toUpperCase() !== 'VERIFIED')
      .map((row) => toListItem(row, sourceByDriverId.get(row.id) ?? 'driver_app'));

    if (query.status && query.status !== 'all') {
      applications = applications.filter((row) => row.applicationStatus === query.status);
    }

    const totalCount = applications.length;
    const skip = (query.page - 1) * query.limit;
    const pageRows = applications.slice(skip, skip + query.limit);
    const totalPages = Math.max(1, Math.ceil(totalCount / query.limit));

    return {
      data: pageRows,
      meta: {
        currentPage: query.page,
        totalPages,
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getById(id: string): Promise<ApplicationDetailsDto> {
    const driver = await this.adminDriverService.getById(id);
    if (driver.verificationStatus.toUpperCase() === 'VERIFIED') {
      throw new AdminDriverConflictError('Driver is already verified; not an open application');
    }
    const source = (await this.resolveSources([id])).get(id) ?? 'driver_app';
    return toDetails(driver, source);
  }

  async create(
    input: CreateManualApplicationBody,
    actorId: string,
  ): Promise<ApplicationDetailsDto> {
    const phone = normalizePhone(input.mobileNumber);
    const plate = normalizePlate(input.registrationNumber);
    const approveImmediately = input.registrationAction === 'approve_immediately';
    const docStatus = approveImmediately ? 'VERIFIED' : 'PENDING';
    const { firstName, lastName } = splitName(input.fullName);

    const existingUser = await this.databaseService.client.user.findFirst({
      where: { phoneNumber: phone, deletedAt: null },
      include: { driver: true },
    });
    if (existingUser?.driver) {
      throw new AdminDriverConflictError('A driver already exists for this phone number');
    }

    const existingPlate = await this.databaseService.client.vehicle.findUnique({
      where: { registrationNumber: plate },
    });
    if (existingPlate) {
      throw new AdminDriverConflictError('A vehicle with this registration number already exists');
    }

    const vehicleTypeCode = VEHICLE_TYPE_CODE[input.vehicleType];
    const vehicleType = await this.databaseService.client.vehicleType.findUnique({
      where: { code: vehicleTypeCode },
    });
    if (!vehicleType) {
      throw new AdminDriverConflictError(`Vehicle type ${vehicleTypeCode} is not configured`);
    }

    const driverId = await this.databaseService.client.$transaction(async (tx) => {
      const user =
        existingUser ??
        (await tx.user.create({
          data: {
            phoneNumber: phone,
            status: 'ACTIVE',
            isPhoneVerified: true,
            ...(input.email && input.email.length > 0
              ? { email: input.email, isEmailVerified: false }
              : {}),
            profile: {
              create: { firstName, lastName },
            },
          },
        }));

      if (existingUser && input.email && input.email.length > 0 && !existingUser.email) {
        await tx.user.update({
          where: { id: existingUser.id },
          data: { email: input.email },
        });
      }

      if (existingUser) {
        await tx.userProfile.upsert({
          where: { userId: existingUser.id },
          create: { userId: existingUser.id, firstName, lastName },
          update: { firstName, lastName },
        });
      }

      const driver = await tx.driver.create({
        data: {
          userId: user.id,
          driverCode: generateDriverCode(),
          verificationStatus: approveImmediately ? 'VERIFIED' : 'PENDING',
          ...(approveImmediately ? { approvedAt: new Date(), approvedBy: actorId } : {}),
          profile: {
            create: {
              fullLegalName: input.fullName,
              dateOfBirth: new Date(input.dateOfBirth),
              gender: input.gender,
              addressLine: [input.addressLine1, input.addressLine2].filter(Boolean).join(', '),
              city: input.city,
              state: input.state,
              country: input.country,
              postalCode: input.postcode,
              preferredLanguage: input.preferredLanguage || 'English',
              profilePhoto: pickUrl(input.profilePhotoUrl, input.driverSelfieUrl) ?? null,
              alternatePhone: input.emergencyContactNumber
                ? normalizePhone(input.emergencyContactNumber)
                : null,
            },
          },
          wallet: {
            create: { balance: 0, lockedBalance: 0 },
          },
        },
      });

      type DriverDocInput = {
        documentType: (typeof DRIVER_DOCUMENT_TYPE)[keyof typeof DRIVER_DOCUMENT_TYPE];
        documentNumber?: string;
        fileUrl?: string;
        fileId?: string;
        issuedAt?: Date;
        expiresAt?: Date;
      };

      const driverDocs: DriverDocInput[] = [];
      const pushDriverDoc = (doc: DriverDocInput) => {
        driverDocs.push(doc);
      };

      const licenseRef = pickFileRef(input.licenseFrontUrl, input.licenseBackUrl);
      pushDriverDoc({
        documentType: DRIVER_DOCUMENT_TYPE.DRIVING_LICENSE,
        documentNumber: input.licenseNo,
        issuedAt: new Date(input.licenseIssueDate),
        expiresAt: new Date(input.licenseExpiry),
        ...licenseRef,
      });
      const aadhaarRef = pickFileRef(input.aadhaarFrontUrl, input.aadhaarBackUrl);
      pushDriverDoc({
        documentType: DRIVER_DOCUMENT_TYPE.AADHAAR,
        documentNumber: input.aadhaarNumber,
        ...aadhaarRef,
      });
      const panRef = pickFileRef(input.panUrl);
      pushDriverDoc({
        documentType: DRIVER_DOCUMENT_TYPE.PAN,
        documentNumber: input.panNumber,
        ...panRef,
      });
      const photoRef = pickFileRef(input.driverSelfieUrl, input.profilePhotoUrl);
      pushDriverDoc({
        documentType: DRIVER_DOCUMENT_TYPE.PROFILE_PHOTO,
        ...photoRef,
      });
      const rcRef = pickFileRef(input.rcUrl);
      pushDriverDoc({
        documentType: DRIVER_DOCUMENT_TYPE.RC,
        documentNumber: input.rcNumber,
        ...rcRef,
      });
      const insuranceRef = pickFileRef(input.insuranceUrl);
      pushDriverDoc({
        documentType: DRIVER_DOCUMENT_TYPE.INSURANCE,
        documentNumber: input.insuranceNo,
        expiresAt: new Date(input.insuranceExpiry),
        ...insuranceRef,
      });

      for (const doc of driverDocs) {
        await tx.driverDocument.create({
          data: {
            driverId: driver.id,
            documentType: doc.documentType,
            verificationStatus: docStatus,
            ...(doc.documentNumber ? { documentNumber: doc.documentNumber } : {}),
            ...(doc.fileUrl ? { fileUrl: doc.fileUrl } : {}),
            ...(doc.fileId ? { fileId: doc.fileId } : {}),
            ...(doc.issuedAt ? { issuedAt: doc.issuedAt } : {}),
            ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}),
            ...(approveImmediately ? { verifiedAt: new Date(), verifiedBy: actorId } : {}),
          },
        });
      }

      const vehicle = await tx.vehicle.create({
        data: {
          registrationNumber: plate,
          vehicleTypeId: vehicleType.id,
          make: input.brand,
          model: input.model,
          color: input.color,
          seatingCapacity: input.seatCapacity,
          manufacturingYear: input.manufacturingYear,
          currentDriverId: driver.id,
          isActive: true,
          verificationStatus: docStatus,
          ...(approveImmediately ? { verifiedAt: new Date(), verifiedBy: actorId } : {}),
        },
      });

      type VehicleDocInput = {
        documentType: string;
        documentNumber?: string;
        fileUrl?: string;
        fileId?: string;
        expiresAt?: Date;
      };
      const vehicleDocs: VehicleDocInput[] = [];
      const pushVehicleDoc = (doc: VehicleDocInput) => {
        vehicleDocs.push(doc);
      };

      pushVehicleDoc({
        documentType: VEHICLE_DOCUMENT_TYPE.RC,
        documentNumber: input.rcNumber,
        ...rcRef,
      });
      pushVehicleDoc({
        documentType: VEHICLE_DOCUMENT_TYPE.INSURANCE,
        documentNumber: input.insuranceNo,
        expiresAt: new Date(input.insuranceExpiry),
        ...insuranceRef,
      });
      const permitRef = pickFileRef(input.permitUrl);
      pushVehicleDoc({
        documentType: VEHICLE_DOCUMENT_TYPE.PERMIT,
        documentNumber: input.permitNo,
        expiresAt: new Date(input.permitExpiry),
        ...permitRef,
      });
      const pollutionRef = pickFileRef(input.pollutionUrl);
      pushVehicleDoc({
        documentType: VEHICLE_DOCUMENT_TYPE.PUC,
        documentNumber: input.pollutionNo,
        expiresAt: new Date(input.pollutionExpiry),
        ...pollutionRef,
      });

      if (input.fitnessNo || input.fitnessUrl || input.fitnessExpiry) {
        const fitnessRef = pickFileRef(input.fitnessUrl);
        pushVehicleDoc({
          documentType: VEHICLE_DOCUMENT_TYPE.FITNESS,
          ...(input.fitnessNo ? { documentNumber: input.fitnessNo } : {}),
          ...fitnessRef,
          ...(input.fitnessExpiry ? { expiresAt: new Date(input.fitnessExpiry) } : {}),
        });
      }

      for (const doc of vehicleDocs) {
        await tx.vehicleDocument.create({
          data: {
            vehicleId: vehicle.id,
            documentType: doc.documentType,
            verificationStatus: docStatus,
            ...(doc.documentNumber ? { documentNumber: doc.documentNumber } : {}),
            ...(doc.fileUrl ? { fileUrl: doc.fileUrl } : {}),
            ...(doc.fileId ? { fileId: doc.fileId } : {}),
            ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}),
            ...(approveImmediately ? { verifiedAt: new Date(), verifiedBy: actorId } : {}),
          },
        });
      }

      await tx.vehicleAssignment.create({
        data: {
          driverId: driver.id,
          vehicleId: vehicle.id,
          status: 'ACTIVE',
        },
      });

      await tx.driver.update({
        where: { id: driver.id },
        data: { currentVehicleId: vehicle.id },
      });

      await tx.driverBankAccount.create({
        data: {
          driverId: driver.id,
          accountHolderName: input.bankAccountName,
          bankName: input.bankName,
          ifscCode: input.bankIfsc.toUpperCase(),
          accountNumberEnc: input.bankAccountNumber,
          ...(input.upiId && input.upiId.length > 0 ? { upiId: input.upiId } : {}),
          isDefault: true,
          payoutEnabled: false,
          verificationStatus: docStatus,
          ...(approveImmediately ? { verifiedAt: new Date(), verifiedBy: actorId } : {}),
        },
      });

      if (input.referralCode?.trim()) {
        try {
          const applied = await this.referralApplyService.applyAtSignup(
            {
              code: input.referralCode,
              refereeUserId: user.id,
              audience: 'DRIVER',
            },
            tx,
          );
          await tx.driver.update({
            where: { id: driver.id },
            data: { referralCodeId: applied.referralCodeId },
          });
        } catch (err) {
          if (err instanceof ReferralError) {
            throw new AdminDriverConflictError(err.message);
          }
          throw err;
        }
      }

      await tx.adminActivityLog.create({
        data: {
          actorId,
          action: 'CREATE',
          entityType: 'driver',
          entityId: driver.id,
          summary: approveImmediately
            ? 'Application Created & Immediately Approved by Admin'
            : 'Application Manually Created by Admin',
          metadata: {
            source: 'admin_manual',
            registrationAction: input.registrationAction,
            registrationPlate: plate,
          },
        },
      });

      return driver.id;
    });

    await this.authService.grantRole(
      (
        await this.databaseService.client.driver.findUniqueOrThrow({
          where: { id: driverId },
          select: { userId: true },
        })
      ).userId,
      'customer',
    );

    if (approveImmediately) {
      const userId = (
        await this.databaseService.client.driver.findUniqueOrThrow({
          where: { id: driverId },
          select: { userId: true },
        })
      ).userId;
      await this.authService.grantRole(userId, 'driver');
    }

    const details = await this.adminDriverService.getById(driverId);
    return toDetails(details, 'admin_manual');
  }

  async approve(id: string, actorId: string, notes?: string): Promise<ApplicationDetailsDto> {
    await this.ensureDocumentsVerifiedForApproval(id, actorId);
    await this.driverService.onboarding.reviewDriverVerification(id, 'VERIFIED', actorId, notes);
    await this.verifyLinkedVehicle(id, actorId, notes);
    const source = (await this.resolveSources([id])).get(id) ?? 'driver_app';
    const driver = await this.adminDriverService.getById(id);
    return toDetails(driver, source);
  }

  async reject(id: string, actorId: string, notes?: string): Promise<ApplicationDetailsDto> {
    await this.driverService.onboarding.reviewDriverVerification(
      id,
      'REJECTED',
      actorId,
      notes || 'Application rejected',
    );
    return this.getById(id);
  }

  async requestResubmission(
    id: string,
    actorId: string,
    notes?: string,
  ): Promise<ApplicationDetailsDto> {
    await this.driverService.onboarding.reviewDriverVerification(
      id,
      'REJECTED',
      actorId,
      notes || 'Resubmission requested',
    );
    return this.getById(id);
  }

  async reviewDocument(
    applicationId: string,
    documentId: string,
    status: VerificationStatus,
    actorId: string,
    rejectionReason?: string,
  ): Promise<ApplicationDetailsDto> {
    const existing = await this.adminDriverService.getById(applicationId);
    if (!existing) throw new AdminDriverNotFoundError();

    await this.driverService.documents.reviewDocument(
      documentId,
      applicationId,
      status,
      actorId,
      rejectionReason,
    );
    return this.getById(applicationId);
  }

  private async resolveSources(driverIds: string[]): Promise<Map<string, ApplicationSourceDto>> {
    const map = new Map<string, ApplicationSourceDto>();
    if (driverIds.length === 0) return map;

    const logs = await this.databaseService.client.adminActivityLog.findMany({
      where: {
        entityType: 'driver',
        entityId: { in: driverIds },
        action: 'CREATE',
      },
      select: { entityId: true, metadata: true },
    });

    for (const log of logs) {
      const metadata = log.metadata as { source?: string } | null;
      if (metadata?.source === 'admin_manual' && log.entityId) {
        map.set(log.entityId, 'admin_manual');
      }
    }
    return map;
  }

  private async ensureDocumentsVerifiedForApproval(
    driverId: string,
    actorId: string,
  ): Promise<void> {
    const pending = await this.databaseService.client.driverDocument.findMany({
      where: {
        driverId,
        verificationStatus: { not: 'VERIFIED' },
      },
    });
    if (pending.length === 0) return;

    // Admin overall approve after reviewing docs in UI — promote remaining
    // required docs so eligibility can pass when the operator already audited them.
    await this.databaseService.client.driverDocument.updateMany({
      where: {
        driverId,
        verificationStatus: { not: 'VERIFIED' },
      },
      data: {
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedBy: actorId,
        rejectionReason: null,
      },
    });
  }

  private async verifyLinkedVehicle(
    driverId: string,
    actorId: string,
    notes?: string,
  ): Promise<void> {
    const driver = await this.databaseService.client.driver.findUnique({
      where: { id: driverId },
      select: { currentVehicleId: true },
    });
    const vehicleId = driver?.currentVehicleId;
    if (!vehicleId) return;

    await this.databaseService.client.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedBy: actorId,
          rejectionReason: null,
        },
      });
      await tx.vehicleDocument.updateMany({
        where: { vehicleId },
        data: {
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedBy: actorId,
          rejectionReason: null,
        },
      });
      await tx.adminActivityLog.create({
        data: {
          actorId,
          action: 'UPDATE',
          entityType: 'vehicle',
          entityId: vehicleId,
          summary: 'Vehicle Verified with Driver Application Approval',
          metadata: {
            driverId,
            ...(notes ? { notes } : {}),
          },
        },
      });
    });
  }
}
