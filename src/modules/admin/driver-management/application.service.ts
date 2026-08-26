import { DriverService } from '@modules/drivers/services/driver.service.js';
import type { VerificationStatus } from '@modules/drivers/types/index.js';
import { AdminDriverNotFoundError, AdminDriverConflictError } from './driver.errors.js';
import {
  AdminDriverService,
  type DriverDetailsDto,
  type DriverListItemDto,
} from './driver.service.js';
import type { ListApplicationsQuery } from './application.schemas.js';

export type ApplicationStatusDto =
  'pending_review' | 'under_review' | 'approved' | 'rejected' | 'resubmission_required';

export interface ApplicationListItemDto {
  id: string;
  applicationId: string;
  driverId: string;
  driverName: string;
  mobileNumber: string;
  vehicleType: string;
  applicationStatus: ApplicationStatusDto;
  source: 'driver_app';
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

function toApplicationStatus(verificationStatus: string): ApplicationStatusDto {
  const status = verificationStatus.toUpperCase();
  if (status === 'VERIFIED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  if (status === 'DOCUMENT_REVIEW') return 'under_review';
  return 'pending_review';
}

function toListItem(driver: DriverListItemDto): ApplicationListItemDto {
  return {
    id: driver.id,
    applicationId:
      driver.driverCode || `APP-${driver.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    driverId: driver.id,
    driverName: driver.driverName,
    mobileNumber: driver.mobileNumber,
    vehicleType: driver.vehicleType,
    applicationStatus: toApplicationStatus(driver.verificationStatus),
    source: 'driver_app',
    submittedAt: driver.joinedAt || driver.createdAt,
    createdAt: driver.createdAt,
    updatedAt: driver.updatedAt,
  };
}

function toDetails(driver: DriverDetailsDto): ApplicationDetailsDto {
  const base = toListItem(driver);
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

export class AdminApplicationService {
  constructor(
    private readonly adminDriverService: AdminDriverService,
    private readonly driverService: DriverService,
  ) {}

  async list(query: ListApplicationsQuery): Promise<{
    data: ApplicationListItemDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    // Applications are unverified drivers. Fetch a wide page from the driver
    // catalog, then shape + filter for the applications vocabulary.
    const drivers = await this.adminDriverService.list({
      page: 1,
      limit: 100,
      ...(query.search ? { search: query.search } : {}),
      status: 'all',
    });

    let applications = drivers.data
      .filter((row) => row.verificationStatus.toUpperCase() !== 'VERIFIED')
      .map(toListItem);

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
    return toDetails(driver);
  }

  async approve(id: string, actorId: string, notes?: string): Promise<ApplicationDetailsDto> {
    await this.driverService.onboarding.reviewDriverVerification(id, 'VERIFIED', actorId, notes);
    // Approved applications leave the queue — return the mapped driver snapshot
    // before conflict on getById.
    const driver = await this.adminDriverService.getById(id);
    return toDetails(driver);
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
}
