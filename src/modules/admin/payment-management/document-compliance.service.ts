import { DatabaseService } from '@core/database';
import type { DriverService } from '@modules/drivers/services/driver.service.js';
import type { VerificationStatus } from '../../../generated/prisma/index.js';
import { SystemSettingService } from '../system-settings/services/system-setting.service.js';
import { recordAdminAction, type AuditActor } from '../audit/index.js';
import { FinanceNotFoundError } from './finance.errors.js';
import {
  daysUntil,
  expiryStatus,
  isoDate,
  mapDocType,
  mapVerificationStatus,
  pageMeta,
} from './finance.mappers.js';
import type {
  DocumentSettingsBody,
  ListDocumentComplianceQuery,
} from './document-compliance.schemas.js';

const SETTINGS_CATEGORY = 'documents';
const KEY_THRESHOLD = 'documents.alert_threshold_days';
const KEY_NOTIFY_EMAIL = 'documents.notify_email';
const KEY_NOTIFY_PUSH = 'documents.notify_push';

const EXPECTED_DOCS = 6;

type ComplianceState = 'compliant' | 'expiring_soon' | 'non_compliant' | 'incomplete';
type DriverVerifStatus = 'all_verified' | 'pending' | 'has_rejected';

export class DocumentComplianceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly systemSettingService: SystemSettingService,
    private readonly driverService: DriverService,
  ) {}

  private get client() {
    return this.db.client;
  }

  async getSettings() {
    const map = await this.systemSettingService.getCategorySettings(SETTINGS_CATEGORY);
    const thresholdRaw = map.get(KEY_THRESHOLD)?.value;
    const notifyEmailRaw = map.get(KEY_NOTIFY_EMAIL)?.value;
    const notifyPushRaw = map.get(KEY_NOTIFY_PUSH)?.value;

    return {
      alertThresholdDays: thresholdRaw ? Number(thresholdRaw) || 30 : 30,
      notifyEmail: notifyEmailRaw == null ? true : notifyEmailRaw === 'true',
      notifyPush: notifyPushRaw == null ? true : notifyPushRaw === 'true',
    };
  }

  async updateSettings(body: DocumentSettingsBody, actorId: string) {
    await this.client.$transaction(async (tx) => {
      await this.systemSettingService.setSetting(
        {
          key: KEY_THRESHOLD,
          value: String(body.alertThresholdDays),
          category: SETTINGS_CATEGORY,
          description: 'Days before expiry to flag documents as expiring soon',
          updatedBy: actorId,
        },
        tx,
      );
      await this.systemSettingService.setSetting(
        {
          key: KEY_NOTIFY_EMAIL,
          value: String(body.notifyEmail),
          category: SETTINGS_CATEGORY,
          description: 'Email notifications for document expiry',
          updatedBy: actorId,
        },
        tx,
      );
      await this.systemSettingService.setSetting(
        {
          key: KEY_NOTIFY_PUSH,
          value: String(body.notifyPush),
          category: SETTINGS_CATEGORY,
          description: 'Push notifications for document expiry',
          updatedBy: actorId,
        },
        tx,
      );
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'SystemSetting',
        summary: 'Updated document compliance settings',
        after: body,
      });
    });

    return this.getSettings();
  }

  private driverName(driver: {
    profile?: { fullLegalName?: string | null } | null;
    user?: {
      profile?: { firstName?: string | null; lastName?: string | null } | null;
    } | null;
    driverCode: string;
  }): string {
    if (driver.profile?.fullLegalName) return driver.profile.fullLegalName;
    const parts = [driver.user?.profile?.firstName, driver.user?.profile?.lastName].filter(Boolean);
    return parts.length ? parts.join(' ') : driver.driverCode;
  }

  private toDocDto(
    doc: {
      id: string;
      documentType: string;
      documentNumber?: string | null;
      fileUrl: string | null;
      fileId: string | null;
      issuedAt: Date | null;
      expiresAt: Date | null;
      verificationStatus: string;
      createdAt: Date;
      rejectionReason?: string | null;
      verifiedAt?: Date | null;
      verifiedBy?: string | null;
      file?: { fileName?: string | null } | null;
    },
    driverName: string,
    thresholdDays: number,
    driverId: string,
    target: 'driver' | 'vehicle',
    vehicleInfo?: {
      plate?: string | null;
      makeModel?: string | null;
      typeCode?: string | null;
      categoryLabel?: string | null;
    } | null,
  ) {
    return {
      id: doc.id,
      driverId,
      driverName,
      target,
      docType: mapDocType(doc.documentType),
      documentType: doc.documentType,
      documentNumber: doc.documentNumber ?? null,
      fileName:
        doc.file?.fileName ??
        doc.fileUrl?.split('/').pop() ??
        `${doc.documentType.toLowerCase()}.pdf`,
      fileUrl: doc.fileUrl,
      fileId: doc.fileId,
      uploadDate: isoDate(doc.createdAt),
      issueDate: doc.issuedAt ? isoDate(doc.issuedAt) : '',
      expiryDate: doc.expiresAt ? isoDate(doc.expiresAt) : '',
      daysUntilExpiry: daysUntil(doc.expiresAt),
      status: expiryStatus(doc.expiresAt, thresholdDays),
      expiryThresholdDays: thresholdDays,
      verificationStatus: mapVerificationStatus(doc.verificationStatus),
      rejectionReason: doc.rejectionReason ?? null,
      verifiedAt: doc.verifiedAt ? isoDate(doc.verifiedAt) : null,
      verifiedBy: doc.verifiedBy ?? null,
      vehiclePlate: vehicleInfo?.plate ?? null,
      vehicleMakeModel: vehicleInfo?.makeModel ?? null,
      vehicleType: vehicleInfo?.typeCode ?? null,
      vehicleCategoryLabel: vehicleInfo?.categoryLabel ?? null,
    };
  }

  private summarize(
    driver: {
      id: string;
      driverCode: string;
      createdAt: Date;
      approvedAt: Date | null;
      rating?: unknown;
      totalRides?: number;
      profile?: {
        fullLegalName?: string | null;
        drivingExperienceYears?: number | null;
        city?: string | null;
      } | null;
      wallet?: { balance: unknown } | null;
      user: {
        phoneNumber: string;
        profile?: { firstName?: string | null; lastName?: string | null } | null;
      };
      documents: Array<{
        id: string;
        driverId: string;
        documentType: string;
        documentNumber?: string | null;
        fileUrl: string | null;
        fileId: string | null;
        issuedAt: Date | null;
        expiresAt: Date | null;
        verificationStatus: string;
        createdAt: Date;
        rejectionReason?: string | null;
        verifiedAt?: Date | null;
        verifiedBy?: string | null;
        file?: { fileName?: string | null } | null;
      }>;
      assignments?: Array<{
        vehicle?: {
          id: string;
          registrationNumber: string;
          make: string | null;
          model: string | null;
          fuelType: string | null;
          seatingCapacity: number | null;
          vehicleType: { code: string; name: string };
          documents: Array<{
            id: string;
            vehicleId: string;
            documentType: string;
            documentNumber?: string | null;
            fileUrl: string | null;
            fileId: string | null;
            issuedAt: Date | null;
            expiresAt: Date | null;
            verificationStatus: string;
            createdAt: Date;
            rejectionReason?: string | null;
            verifiedAt?: Date | null;
            verifiedBy?: string | null;
            file?: { fileName?: string | null } | null;
          }>;
        };
      }>;
    },
    thresholdDays: number,
  ) {
    const name = this.driverName(driver);
    const activeAssignment = driver.assignments?.[0];
    const activeVehicle = activeAssignment?.vehicle;
    const vehicleInfo = activeVehicle
      ? {
          plate: activeVehicle.registrationNumber,
          makeModel:
            [activeVehicle.make, activeVehicle.model].filter(Boolean).join(' ') ||
            'Commercial Vehicle',
          typeCode: activeVehicle.vehicleType?.code ?? 'cab_economy',
          categoryLabel: activeVehicle.vehicleType?.name ?? 'Cab Economy',
          fuelType: activeVehicle.fuelType,
          seatsCapacity: activeVehicle.seatingCapacity,
        }
      : null;

    const driverDocs = driver.documents.map((d) =>
      this.toDocDto(d, name, thresholdDays, driver.id, 'driver', vehicleInfo),
    );
    const vehicleDocs = (activeVehicle?.documents ?? []).map((vd) =>
      this.toDocDto(vd, name, thresholdDays, driver.id, 'vehicle', vehicleInfo),
    );
    const documents = [...driverDocs, ...vehicleDocs];
    const uploadedDocs = documents.length;

    let complianceState: ComplianceState = 'compliant';
    if (uploadedDocs < EXPECTED_DOCS) complianceState = 'incomplete';
    else if (documents.some((d) => d.status === 'expired')) complianceState = 'non_compliant';
    else if (documents.some((d) => d.status === 'expiring_soon')) complianceState = 'expiring_soon';

    let verificationStatus: DriverVerifStatus = 'all_verified';
    if (documents.some((d) => d.verificationStatus === 'rejected'))
      verificationStatus = 'has_rejected';
    else if (documents.some((d) => d.verificationStatus === 'pending'))
      verificationStatus = 'pending';

    const expiryDates = documents
      .map((d) => d.expiryDate)
      .filter((d) => d.length > 0)
      .sort();

    return {
      driverId: driver.id,
      driverCode: driver.driverCode,
      driverName: name,
      mobile: driver.user.phoneNumber,
      onboardedOn: isoDate(driver.approvedAt ?? driver.createdAt),
      city: driver.profile?.city ?? 'Srinagar',
      totalTrips: driver.totalRides ?? 0,
      ratingAvg: driver.rating ? Number(driver.rating) : 5.0,
      drivingExpYears: driver.profile?.drivingExperienceYears ?? 0,
      walletBalance: driver.wallet?.balance ? Number(driver.wallet.balance) : 0,
      vehiclePlate: vehicleInfo?.plate ?? null,
      vehicleMakeModel: vehicleInfo?.makeModel ?? null,
      vehicleType: vehicleInfo?.typeCode ?? null,
      vehicleCategoryLabel: vehicleInfo?.categoryLabel ?? null,
      seatsCapacity: vehicleInfo?.seatsCapacity ?? null,
      fuelType: vehicleInfo?.fuelType ?? null,
      totalDocs: EXPECTED_DOCS,
      uploadedDocs,
      complianceState,
      nearestExpiry: expiryDates[0] ?? '—',
      verificationStatus,
      documents,
    };
  }

  async listCompliance(query: ListDocumentComplianceQuery) {
    const settings = await this.getSettings();
    const threshold = query.alertThresholdDays ?? settings.alertThresholdDays;

    const where = {
      deletedAt: null as Date | null,
      ...(query.search
        ? {
            OR: [
              { driverCode: { contains: query.search, mode: 'insensitive' as const } },
              {
                profile: {
                  fullLegalName: { contains: query.search, mode: 'insensitive' as const },
                },
              },
              { user: { phoneNumber: { contains: query.search } } },
            ],
          }
        : {}),
    };

    const drivers = await this.client.driver.findMany({
      where,
      include: {
        profile: true,
        user: { include: { profile: true } },
        documents: { include: { file: true } },
        wallet: { select: { balance: true } },
        assignments: {
          where: { releasedAt: null, status: 'ACTIVE' },
          include: {
            vehicle: {
              include: {
                vehicleType: true,
                documents: { include: { file: true } },
              },
            },
          },
          orderBy: { assignedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    let summaries = drivers.map((d) => this.summarize(d, threshold));
    if (query.complianceState && query.complianceState !== 'all') {
      summaries = summaries.filter((s) => s.complianceState === query.complianceState);
    }

    let expiredCount = 0;
    let expiring7dCount = 0;
    let expiring30dCount = 0;
    let validCount = 0;
    let totalDocsCount = 0;

    for (const s of summaries) {
      for (const d of s.documents) {
        totalDocsCount++;
        if (d.status === 'expired') {
          expiredCount++;
        } else if (d.daysUntilExpiry !== null && d.daysUntilExpiry <= 7) {
          expiring7dCount++;
        } else if (d.status === 'expiring_soon') {
          expiring30dCount++;
        } else {
          validCount++;
        }
      }
    }

    const totalCount = summaries.length;
    const start = (query.page - 1) * query.limit;
    const data = summaries.slice(start, start + query.limit);

    return {
      data,
      meta: {
        ...pageMeta(query.page, query.limit, totalCount),
        counts: {
          expired: expiredCount,
          expiring7d: expiring7dCount,
          expiring30d: expiring30dCount,
          valid: validCount,
          total: totalDocsCount,
        },
      },
    };
  }

  async getCompliance(driverId: string, alertThresholdDays?: number) {
    const settings = await this.getSettings();
    const threshold = alertThresholdDays ?? settings.alertThresholdDays;

    const driver = await this.client.driver.findUnique({
      where: { id: driverId },
      include: {
        profile: true,
        user: { include: { profile: true } },
        documents: { include: { file: true } },
        wallet: { select: { balance: true } },
        assignments: {
          where: { releasedAt: null, status: 'ACTIVE' },
          include: {
            vehicle: {
              include: {
                vehicleType: true,
                documents: { include: { file: true } },
              },
            },
          },
          orderBy: { assignedAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!driver || driver.deletedAt) {
      throw new FinanceNotFoundError('Driver was not found');
    }

    return this.summarize(driver, threshold);
  }

  async reviewDocument(
    documentId: string,
    status: VerificationStatus,
    actor: AuditActor,
    rejectionReason?: string,
  ) {
    const driverDoc = await this.client.driverDocument.findUnique({ where: { id: documentId } });
    if (driverDoc) {
      const reviewed = await this.driverService.documents.reviewDocument(
        documentId,
        driverDoc.driverId,
        status,
        actor,
        rejectionReason,
      );

      return {
        id: reviewed.id,
        driverId: reviewed.driverId,
        verificationStatus: mapVerificationStatus(reviewed.verificationStatus),
        rejectionReason: reviewed.rejectionReason ?? undefined,
      };
    }

    const vehicleDoc = await this.client.vehicleDocument.findUnique({ where: { id: documentId } });
    if (vehicleDoc) {
      const reviewed = await this.client.vehicleDocument.update({
        where: { id: documentId },
        data: {
          verificationStatus: status,
          rejectionReason: rejectionReason ?? null,
          ...(status === 'VERIFIED' ? { verifiedAt: new Date(), verifiedBy: actor.actorId } : {}),
        },
      });

      return {
        id: reviewed.id,
        vehicleId: reviewed.vehicleId,
        verificationStatus: mapVerificationStatus(reviewed.verificationStatus),
        rejectionReason: reviewed.rejectionReason ?? undefined,
      };
    }

    throw new FinanceNotFoundError('Document was not found');
  }
}
