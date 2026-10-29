import { DatabaseService } from '@core/database';
import { maskAccountNumber } from '@shared/crypto/bank-account-crypto.js';
import type { UserStatus } from '@core/database/types';
import { Prisma } from '../../../../generated/prisma/index.js';
import { UserRepository } from '@modules/auth/repositories/user.repository.js';
import { SessionService } from '@modules/auth/services/session/session.service.js';
import type { EpochService } from '@modules/auth/services/token/epoch.service.js';
import { DriverService } from '@modules/drivers/services/driver.service.js';
import { lockForAudit, recordAdminAction, type AuditActor } from '../../audit/index.js';
import { AdminDriverConflictError, AdminDriverNotFoundError } from '../driver.errors.js';
import type { ListDriversQuery, UpdateDriverBody } from './driver.schemas.js';

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
  /// The operator's last reason or instructions. With PENDING it marks an application sent
  /// back for corrections.
  rejectionReason?: string;
  ratingAvg: number;
  totalTrips: number;
  walletBalance: number;
  commissionWalletBalance?: number | undefined;
  earningsBalance?: number | undefined;
  paymentModel?: string | undefined;
  pendingPaymentModel?: string | undefined;
  profilePhotoUrl?: string;
  documentsCount?: number;
  totalDocuments?: number;
  licenseExpiry?: string;
  insuranceExpiry?: string;
  permitExpiry?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  subscription?:
    | {
        planName?: string | undefined;
        status: string;
        expiryDate?: string | undefined;
        startDate?: string | undefined;
        endDate?: string | undefined;
        amount?: number | undefined;
        autoRenew?: boolean | undefined;
      }
    | null
    | undefined;
  joinedAt: string;
  lastActiveAt?: string;
  isOnline: boolean;
  isSuspended: boolean;
  isBlocked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DriverDetailsDto extends DriverListItemDto {
  emergencyContactName?: string;
  emergencyContactNumber?: string;
  emergencyContactRelationship?: string;
  emergencyContacts?: Array<{
    id: string;
    contactName: string;
    phoneNumber: string;
    relationship?: string | null;
  }>;
  gender?: string;
  dateOfBirth?: string;
  preferredLanguage?: string;
  country?: string;
  state?: string;
  city?: string;
  postcode?: string;
  addressLine1?: string;
  addressLine2?: string;
  bloodGroup?: string;
  alternatePhone?: string;
  drivingExperienceYears?: number;
  documents: Array<{
    id: string;
    driverId: string;
    docType: string;
    docNumber?: string;
    fileUrl: string;
    fileId?: string;
    /// Back of a two-sided card, when the driver supplied one.
    backFileId?: string;
    contentType?: string;
    backContentType?: string;
    isPdf?: boolean;
    issuedDate?: string;
    expiryDate?: string;
    verifyStatus: string;
    comment?: string;
    verifiedAt?: string;
    createdAt: string;
    category?: 'driver' | 'vehicle';
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
    fuelType?: string;
    seatsCapacity?: number;
    manufacturingYear?: number;
    photoUrl?: string | undefined;
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
  bankAccountName?: string | undefined;
  bankAccountNumber?: string | null | undefined;
  bankIfsc?: string | undefined;
  bankName?: string | undefined;
  upiId?: string | undefined;
  bankAccounts: Array<{
    id: string;
    bankAccountName?: string;
    bankName?: string;
    bankIfsc?: string;
    /// Last four digits only (`****1234`) — the number itself is never returned.
    accountNumberMasked: string | null;
    upiId?: string;
    status: string;
    verificationStatus: string;
    payoutEnabled: boolean;
    isActive: boolean;
    isDefault: boolean;
  }>;
  commissionWallet?: {
    id?: string | undefined;
    balance: number;
    currency: string;
    lastTransactionAt?: string | undefined;
  };
  commissionWalletBalance?: number | undefined;
  earningsBalance?: number | undefined;
  ledger: Array<{
    id: string;
    date: string;
    type: string;
    amount: number;
    balanceAfter: number;
    description?: string | undefined;
    rideId?: string | undefined;
    referenceType?: string | undefined;
    referenceId?: string | undefined;
  }>;
  commissionLedger?: Array<{
    id: string;
    date: string;
    type: string;
    amount: number;
    balanceAfter: number;
    description?: string | undefined;
    rideId?: string | undefined;
    referenceType?: string | undefined;
    referenceId?: string | undefined;
  }>;
  subscriptionPayments?: Array<{
    id: string;
    date: string;
    plan: string;
    amount: string;
    status: string;
    method: string;
    txId: string;
  }>;
  subscriptionTimeline?: Array<{
    iconType: string;
    title: string;
    subtitle?: string;
    date: string;
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
  paymentModel?: string | undefined;
  pendingPaymentModel?: string | undefined;
  subscription?:
    | {
        id?: string | undefined;
        planId?: string | undefined;
        planName?: string | undefined;
        billingPeriod?: string | undefined;
        status: string;
        expiryDate?: string | undefined;
        startDate?: string | undefined;
        endDate?: string | undefined;
        amount?: number | undefined;
        autoRenew?: boolean | undefined;
        remainingDays?: number | undefined;
      }
    | null
    | undefined;
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
    private readonly epochService: EpochService,
  ) {}

  /// `narrow` filters the rows in the query itself, so paging and the total count are over
  /// the narrowed set (the applications queue relies on it).
  async list(
    query: ListDriversQuery,
    narrow?: Prisma.DriverWhereInput,
  ): Promise<{
    data: DriverListItemDto[];
    meta: { currentPage: number; totalPages: number; pageSize: number; totalCount: number };
  }> {
    const skip = (query.page - 1) * query.limit;
    const base = this.driverWhere(query);
    const where = narrow ? { AND: [base, narrow] } : base;
    const [rows, totalCount] = await Promise.all([
      this.databaseService.client.driver.findMany({
        where: where as never,
        include: {
          profile: true,
          wallet: true,
          commissionWallet: true,
          onlineStatus: true,
          user: { include: { profile: true } },
          documents: {
            select: { id: true, documentType: true, expiresAt: true, verificationStatus: true },
          },
          subscriptions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { plan: true },
          },
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

    const [commissionTxns, walletTxns, activityLogs] = await Promise.all([
      this.databaseService.client.driverCommissionWalletTransaction.findMany({
        where: { driverId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
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

    const subPaymentIntentIds = (row.subscriptions ?? [])
      .map((s) => s.paymentIntentId)
      .filter((pid): pid is string => Boolean(pid));
    const txnPaymentIntentIds = commissionTxns
      .filter((t) => t.referenceType === 'PAYMENT_INTENT' && t.referenceId)
      .map((t) => t.referenceId as string);
    const allIntentIds = Array.from(new Set([...subPaymentIntentIds, ...txnPaymentIntentIds]));
    const paymentIntents =
      allIntentIds.length > 0
        ? await this.databaseService.client.paymentIntent.findMany({
            where: { id: { in: allIntentIds } },
          })
        : [];
    const intentMap = new Map(paymentIntents.map((i) => [i.id, i]));

    const base = this.toListDto(row);
    const assignment = row.assignments[0];
    let vehicle = assignment?.vehicle;
    if (!vehicle && row.currentVehicleId) {
      vehicle = (await this.databaseService.client.vehicle.findUnique({
        where: { id: row.currentVehicleId },
        include: {
          vehicleType: true,
          documents: {
            include: {
              file: { select: { contentType: true, fileName: true } },
              backFile: { select: { contentType: true, fileName: true } },
            },
          },
          images: { orderBy: { uploadedAt: 'desc' }, take: 1 },
        },
      })) as unknown as typeof vehicle;
    }
    if (!vehicle) {
      vehicle = (await this.databaseService.client.vehicle.findFirst({
        where: { currentDriverId: row.id },
        include: {
          vehicleType: true,
          documents: {
            include: {
              file: { select: { contentType: true, fileName: true } },
              backFile: { select: { contentType: true, fileName: true } },
            },
          },
          images: { orderBy: { uploadedAt: 'desc' }, take: 1 },
        },
      })) as unknown as typeof vehicle;
    }

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

    const primaryContact = row.user.emergencyContacts?.[0];

    return {
      ...base,
      ...(primaryContact
        ? {
            emergencyContactName: primaryContact.contactName,
            emergencyContactNumber: primaryContact.phoneNumber,
            ...(primaryContact.relationship
              ? { emergencyContactRelationship: primaryContact.relationship }
              : {}),
            emergencyContacts: row.user.emergencyContacts.map((c) => ({
              id: c.id,
              contactName: c.contactName,
              phoneNumber: c.phoneNumber,
              relationship: c.relationship,
            })),
          }
        : {}),
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
      ...(row.profile?.addressLine
        ? (() => {
            const parts = row.profile.addressLine.split(' | ');
            return {
              addressLine1: parts[0] || row.profile.addressLine,
              ...(parts[1] ? { addressLine2: parts[1] } : {}),
            };
          })()
        : {}),
      ...(row.profile?.bloodGroup ? { bloodGroup: row.profile.bloodGroup } : {}),
      ...(row.profile?.alternatePhone ? { alternatePhone: row.profile.alternatePhone } : {}),
      ...(typeof row.profile?.drivingExperienceYears === 'number'
        ? { drivingExperienceYears: row.profile.drivingExperienceYears }
        : {}),
      documents: [
        ...row.documents.map((doc) => {
          const comment = doc.rejectionReason ?? doc.verificationNotes ?? undefined;
          const isPdf =
            doc.file?.contentType === 'application/pdf' ||
            Boolean(doc.fileUrl && /\.pdf(\?|$)/i.test(doc.fileUrl));
          return {
            id: doc.id,
            driverId: doc.driverId,
            docType: doc.documentType.toLowerCase(),
            ...(doc.documentNumber ? { docNumber: doc.documentNumber } : {}),
            fileUrl: doc.fileUrl ?? '',
            ...(doc.fileId ? { fileId: doc.fileId } : {}),
            ...(doc.backFileId ? { backFileId: doc.backFileId } : {}),
            ...(doc.file?.contentType ? { contentType: doc.file.contentType } : {}),
            ...(doc.backFile?.contentType ? { backContentType: doc.backFile.contentType } : {}),
            isPdf,
            ...(doc.issuedAt ? { issuedDate: doc.issuedAt.toISOString().slice(0, 10) } : {}),
            ...(doc.expiresAt ? { expiryDate: doc.expiresAt.toISOString().slice(0, 10) } : {}),
            verifyStatus: mapDocStatus(doc.verificationStatus),
            ...(comment ? { comment } : {}),
            ...(doc.verifiedAt ? { verifiedAt: doc.verifiedAt.toISOString() } : {}),
            createdAt: doc.createdAt.toISOString(),
            category: 'driver' as const,
          };
        }),
        ...(vehicle?.documents ?? []).map((doc) => {
          const comment = doc.rejectionReason ?? undefined;
          const isPdf =
            doc.file?.contentType === 'application/pdf' ||
            Boolean(doc.fileUrl && /\.pdf(\?|$)/i.test(doc.fileUrl));
          return {
            id: doc.id,
            driverId: row.id,
            docType: doc.documentType.toLowerCase(),
            ...(doc.documentNumber ? { docNumber: doc.documentNumber } : {}),
            fileUrl: doc.fileUrl ?? '',
            ...(doc.fileId ? { fileId: doc.fileId } : {}),
            ...(doc.backFileId ? { backFileId: doc.backFileId } : {}),
            ...(doc.file?.contentType ? { contentType: doc.file.contentType } : {}),
            ...(doc.backFile?.contentType ? { backContentType: doc.backFile.contentType } : {}),
            isPdf,
            ...(doc.issuedAt ? { issuedDate: doc.issuedAt.toISOString().slice(0, 10) } : {}),
            ...(doc.expiresAt ? { expiryDate: doc.expiresAt.toISOString().slice(0, 10) } : {}),
            verifyStatus: mapDocStatus(doc.verificationStatus),
            ...(comment ? { comment } : {}),
            ...(doc.verifiedAt ? { verifiedAt: doc.verifiedAt.toISOString() } : {}),
            createdAt: doc.createdAt.toISOString(),
            category: 'vehicle' as const,
          };
        }),
      ],
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
              ...(vehicle.fuelType ? { fuelType: vehicle.fuelType } : {}),
              ...(vehicle.seatingCapacity != null
                ? { seatsCapacity: vehicle.seatingCapacity }
                : {}),
              ...(vehicle.manufacturingYear
                ? { manufacturingYear: vehicle.manufacturingYear }
                : {}),
              ...(vehicle.images?.[0]?.imageUrl ? { photoUrl: vehicle.images[0].imageUrl } : {}),
              ...vehicleDocFields(vehicle.documents ?? []),
            },
          }
        : {}),
      ...(row.bankAccounts[0]
        ? {
            ...(row.bankAccounts[0].accountHolderName
              ? { bankAccountName: row.bankAccounts[0].accountHolderName }
              : {}),
            ...(row.bankAccounts[0].bankName ? { bankName: row.bankAccounts[0].bankName } : {}),
            ...(row.bankAccounts[0].ifscCode ? { bankIfsc: row.bankAccounts[0].ifscCode } : {}),
            bankAccountNumber: maskAccountNumber(row.bankAccounts[0].accountNumberLast4),
            ...(row.bankAccounts[0].upiId ? { upiId: row.bankAccounts[0].upiId } : {}),
          }
        : {}),
      bankAccounts: row.bankAccounts.map((account) => ({
        id: account.id,
        ...(account.accountHolderName ? { bankAccountName: account.accountHolderName } : {}),
        ...(account.bankName ? { bankName: account.bankName } : {}),
        ...(account.ifscCode ? { bankIfsc: account.ifscCode } : {}),
        accountNumberMasked: maskAccountNumber(account.accountNumberLast4),
        ...(account.upiId ? { upiId: account.upiId } : {}),
        status: account.status,
        verificationStatus: account.verificationStatus,
        payoutEnabled: account.payoutEnabled,
        isActive: account.isActive,
        isDefault: account.isDefault,
      })),
      ...(() => {
        const commissionLedger = commissionTxns.map((txn) => {
          const intent =
            txn.referenceType === 'PAYMENT_INTENT' && txn.referenceId
              ? intentMap.get(txn.referenceId)
              : undefined;
          return {
            id: txn.id,
            date: txn.createdAt.toISOString(),
            type: String(txn.txnType),
            amount: Number(txn.amount),
            balanceAfter: Number(txn.balanceAfter),
            description:
              txn.description ??
              (txn.txnType === 'MANUAL_RECHARGE'
                ? 'Commission wallet recharge'
                : txn.txnType === 'RIDE_COMMISSION'
                  ? 'Ride commission deduction'
                  : String(txn.txnType)),
            ...(txn.rideId ? { rideId: txn.rideId } : {}),
            referenceType: txn.referenceType ?? undefined,
            referenceId: intent?.gatewayIntentId || txn.referenceId || undefined,
          };
        });

        const payoutLedger = walletTxns.map((txn) => ({
          id: txn.id,
          date: txn.createdAt.toISOString(),
          type: String(txn.txnType),
          amount: Number(txn.amount),
          balanceAfter: Number(txn.balanceAfter),
          description: txn.description ?? txn.txnType,
          ...(txn.referenceType === 'ride' && txn.referenceId ? { rideId: txn.referenceId } : {}),
        }));

        const activeSub =
          (row.subscriptions ?? []).find((s) => s.status === 'ACTIVE') ?? row.subscriptions?.[0];

        const subscriptionPayments = (row.subscriptions ?? [])
          .filter(
            (s) =>
              s.paymentStatus === 'PAID' || s.status === 'ACTIVE' || Boolean(s.paymentIntentId),
          )
          .map((s) => {
            const intent = s.paymentIntentId ? intentMap.get(s.paymentIntentId) : undefined;
            const method = intent?.methodType
              ? intent.methodType.toUpperCase() === 'CARD'
                ? 'Razorpay (Card)'
                : intent.methodType.toUpperCase() === 'UPI'
                  ? 'Razorpay (UPI)'
                  : `Razorpay (${intent.methodType})`
              : 'Razorpay (UPI)';
            const txId = intent?.gatewayIntentId || intent?.id || s.paymentIntentId || s.id;
            const date = (s.startDate || s.createdAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            });
            return {
              id: s.id,
              date,
              plan: s.plan.name,
              amount: `₹ ${Number(s.plan.price).toFixed(2)}`,
              status:
                s.paymentStatus === 'PAID' || s.status === 'ACTIVE' ? 'Success' : s.paymentStatus,
              method,
              txId,
            };
          });

        const subscriptionTimeline: Array<{
          iconType: string;
          title: string;
          subtitle?: string;
          date: string;
        }> = [];
        for (const s of row.subscriptions ?? []) {
          const intent = s.paymentIntentId ? intentMap.get(s.paymentIntentId) : undefined;
          const formattedDate = (s.startDate || s.createdAt).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          });
          if (s.status === 'ACTIVE') {
            const hasPriorCommission = Boolean(
              row.commissionWallet &&
              (commissionLedger.length > 0 || Number(row.commissionWallet.balance) > 0),
            );
            subscriptionTimeline.push({
              iconType: 'check',
              title: hasPriorCommission
                ? 'Subscription Activated (Switched from Commission)'
                : 'Subscription Activated',
              subtitle: hasPriorCommission
                ? `${s.plan.name} · ₹${Number(row.commissionWallet?.balance || 0).toFixed(2)} Commission Preserved`
                : s.plan.name,
              date: formattedDate,
            });
            subscriptionTimeline.push({
              iconType: 'payment',
              title: 'Payment Successful',
              subtitle: `₹${Number(s.plan.price).toFixed(2)} via ${intent?.methodType || 'Razorpay'}`,
              date: formattedDate,
            });
            if (s.autoRenew) {
              subscriptionTimeline.push({
                iconType: 'shield',
                title: 'Auto Renewal Enabled',
                date: formattedDate,
              });
            }
          } else if (s.status === 'EXPIRED') {
            subscriptionTimeline.push({
              iconType: 'calendar',
              title: 'Subscription Expired',
              subtitle: s.plan.name,
              date: (s.expiryDate || s.updatedAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              }),
            });
          } else if (s.status === 'CANCELLED') {
            subscriptionTimeline.push({
              iconType: 'refresh',
              title: 'Subscription Cancelled',
              subtitle: s.plan.name,
              date: s.updatedAt.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              }),
            });
          }
        }

        if (row.pendingPaymentModel === 'COMMISSION' && activeSub?.expiryDate) {
          subscriptionTimeline.push({
            iconType: 'refresh',
            title: 'Switch to Commission Scheduled',
            subtitle: `Transition effective at period expiry (${activeSub.expiryDate.toLocaleDateString('en-GB')})`,
            date: activeSub.expiryDate.toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            }),
          });
        }

        const remainingDays =
          activeSub && activeSub.expiryDate
            ? Math.max(
                0,
                Math.ceil((activeSub.expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
              )
            : 0;

        const commBal = row.commissionWallet ? Number(row.commissionWallet.balance) : 0;
        const earnBal = row.wallet ? Number(row.wallet.balance) : 0;
        const effectiveBal = row.paymentModel === 'COMMISSION' || commBal > 0 ? commBal : earnBal;

        return {
          walletBalance: effectiveBal,
          commissionWalletBalance: commBal,
          earningsBalance: earnBal,
          commissionWallet: row.commissionWallet
            ? {
                id: row.commissionWallet.id,
                balance: Number(row.commissionWallet.balance),
                currency: row.commissionWallet.currency,
                lastTransactionAt: row.commissionWallet.lastTransactionAt?.toISOString(),
              }
            : {
                balance: 0,
                currency: 'INR',
              },
          ledger: commissionLedger.length > 0 ? commissionLedger : payoutLedger,
          commissionLedger,
          subscriptionPayments,
          subscriptionTimeline,
          subscription: activeSub
            ? {
                id: activeSub.id,
                planName: activeSub.plan?.name || 'Subscription Plan',
                status: activeSub.status,
                startDate: activeSub.startDate
                  ? activeSub.startDate.toISOString().slice(0, 10)
                  : undefined,
                endDate: activeSub.expiryDate
                  ? activeSub.expiryDate.toISOString().slice(0, 10)
                  : undefined,
                amount: activeSub.plan?.price != null ? Number(activeSub.plan.price) : undefined,
                autoRenew: activeSub.autoRenew,
                remainingDays,
              }
            : null,
        };
      })(),
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
      // The driver's own choice, made in the driver app after approval; absent until then.
      ...(row.paymentModel ? { paymentModel: row.paymentModel } : {}),
      ...(row.pendingPaymentModel ? { pendingPaymentModel: row.pendingPaymentModel } : {}),
    };
  }

  async topUpCommissionWallet(
    driverId: string,
    amount: number,
    actor: AuditActor,
    notes?: string,
  ): Promise<DriverDetailsDto> {
    if (amount <= 0) throw new Error('Top-up amount must be greater than zero');
    await this.databaseService.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'drivers', driverId);
      let wallet = await tx.driverCommissionWallet.findUnique({ where: { driverId } });
      if (!wallet) {
        wallet = await tx.driverCommissionWallet.create({
          data: { driverId, balance: new Prisma.Decimal(0), currency: 'INR' },
        });
      }
      const newBalance = new Prisma.Decimal(wallet.balance).add(new Prisma.Decimal(amount));
      await tx.driverCommissionWallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance, lastTransactionAt: new Date() },
      });
      await tx.driverCommissionWalletTransaction.create({
        data: {
          walletId: wallet.id,
          driverId,
          txnType: 'ADMIN_CREDIT',
          amount: new Prisma.Decimal(amount),
          balanceAfter: newBalance,
          referenceType: 'ADMIN_ADJUSTMENT',
          description: notes || `Admin wallet credit by ${actor.actorId}`,
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'driver_wallet',
        entityId: wallet.id,
        summary: `Admin credited ₹${amount} to driver commission wallet`,
        after: { balance: newBalance.toNumber(), amount },
        result: 'SUCCESS',
      });
    });
    return this.getById(driverId);
  }

  async suspend(id: string, actor: AuditActor, notes?: string): Promise<DriverDetailsDto> {
    return this.setModerationState(id, 'suspended', actor, 'Driver Account Suspended', notes);
  }

  async block(id: string, actor: AuditActor, notes?: string): Promise<DriverDetailsDto> {
    return this.setModerationState(id, 'blocked', actor, 'Driver Account Blocked', notes);
  }

  async activate(id: string, actor: AuditActor, notes?: string): Promise<DriverDetailsDto> {
    return this.setModerationState(id, 'active', actor, 'Driver Account Activated', notes);
  }

  async update(id: string, data: UpdateDriverBody, actor: AuditActor): Promise<DriverDetailsDto> {
    await this.databaseService.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'drivers', id);
      const row = await tx.driver.findFirst({
        where: { id, deletedAt: null },
        include: {
          profile: true,
          user: { include: { profile: true, emergencyContacts: true } },
          bankAccounts: { where: { isActive: true }, orderBy: { createdAt: 'desc' }, take: 1 },
          assignments: {
            where: { status: 'ACTIVE', releasedAt: null },
            take: 1,
            include: { vehicle: true },
          },
        },
      });
      if (!row) throw new AdminDriverNotFoundError();

      // 1. Update User (email, mobileNumber)
      const userUpdates: Prisma.UserUpdateInput = {};
      if (data.email !== undefined && data.email !== '') {
        userUpdates.email = data.email.toLowerCase().trim();
      }
      if (data.mobileNumber && data.mobileNumber.trim()) {
        userUpdates.phoneNumber = data.mobileNumber.trim();
      }
      if (Object.keys(userUpdates).length > 0) {
        await tx.user.update({
          where: { id: row.userId },
          data: userUpdates,
        });
      }

      // 1b. Update UserProfile
      const name = (data.driverName || data.fullName)?.trim();
      if (name) {
        const parts = name.split(/\s+/);
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ');
        await tx.userProfile.upsert({
          where: { userId: row.userId },
          create: {
            userId: row.userId,
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          },
          update: {
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          },
        });
      }

      // 2. Update or create Emergency Contact
      const eName = (data.emergencyContactName || data.emergencyContacts?.[0]?.name)?.trim();
      const ePhone = (
        data.emergencyContactNumber || data.emergencyContacts?.[0]?.phoneNumber
      )?.trim();
      const eRel = (
        data.emergencyContactRelationship || data.emergencyContacts?.[0]?.relationship
      )?.trim();
      if (eName || ePhone) {
        const existingEc = row.user.emergencyContacts?.[0];
        if (existingEc) {
          await tx.emergencyContact.update({
            where: { id: existingEc.id },
            data: {
              ...(eName ? { contactName: eName } : {}),
              ...(ePhone ? { phoneNumber: ePhone } : {}),
              ...(eRel ? { relationship: eRel } : {}),
            },
          });
        } else if (ePhone) {
          await tx.emergencyContact.create({
            data: {
              userId: row.userId,
              contactName: eName || 'Emergency Contact',
              phoneNumber: ePhone,
              relationship: eRel || 'Family',
              priority: 1,
            },
          });
        }
      }

      // 3. Update DriverProfile
      const profileUpdates: Prisma.DriverProfileUncheckedUpdateInput = {};
      if (name) profileUpdates.fullLegalName = name;
      if (data.dateOfBirth) {
        const d = new Date(data.dateOfBirth);
        if (!isNaN(d.getTime())) profileUpdates.dateOfBirth = d;
      }
      if (data.gender) profileUpdates.gender = data.gender;
      if (data.bloodGroup) profileUpdates.bloodGroup = data.bloodGroup;
      if (data.preferredLanguage || data.language) {
        profileUpdates.preferredLanguage = (data.preferredLanguage || data.language)!.trim();
      }
      if (data.city) profileUpdates.city = data.city.trim();
      if (data.state) profileUpdates.state = data.state.trim();
      const addr = (data.addressLine1 || data.address)?.trim();
      if (addr) profileUpdates.addressLine = addr;
      if (data.alternatePhone) profileUpdates.alternatePhone = data.alternatePhone.trim();
      const exp =
        data.drivingExperienceYears ??
        (data.drivingExperience != null ? parseInt(String(data.drivingExperience), 10) : undefined);
      if (exp != null && !isNaN(exp)) profileUpdates.drivingExperienceYears = exp;

      if (Object.keys(profileUpdates).length > 0) {
        if (row.profile) {
          await tx.driverProfile.update({
            where: { driverId: id },
            data: profileUpdates,
          });
        } else {
          await tx.driverProfile.create({
            data: {
              driverId: id,
              ...(name ? { fullLegalName: name } : {}),
              ...(data.dateOfBirth ? { dateOfBirth: new Date(data.dateOfBirth) } : {}),
              ...(data.gender ? { gender: data.gender } : {}),
              ...(data.bloodGroup ? { bloodGroup: data.bloodGroup } : {}),
              ...(data.preferredLanguage || data.language
                ? { preferredLanguage: (data.preferredLanguage || data.language)!.trim() }
                : {}),
              ...(data.city ? { city: data.city.trim() } : {}),
              ...(data.state ? { state: data.state.trim() } : {}),
              ...(addr ? { addressLine: addr } : {}),
              ...(data.alternatePhone ? { alternatePhone: data.alternatePhone.trim() } : {}),
              ...(exp != null && !isNaN(exp) ? { drivingExperienceYears: exp } : {}),
            },
          });
        }
      }

      // 4. Update Driver paymentModel
      if (data.paymentModel) {
        const pm = data.paymentModel.toUpperCase();
        if (pm === 'COMMISSION' || pm === 'SUBSCRIPTION') {
          await tx.driver.update({
            where: { id },
            data: { paymentModel: pm },
          });
        }
      }

      // 5. Update Vehicle
      const vMake = (data.vehicle?.brand || data.vehicleMake)?.trim();
      const vModel = (data.vehicle?.model || data.vehicleModel)?.trim();
      const vPlate = (data.vehicle?.registrationNo || data.registrationPlate)?.trim();
      const vColor = (data.vehicle?.color || data.vehicleColor)?.trim();
      const vYearRaw = data.vehicle?.yearOfManufacture ?? data.manufacturingYear;
      const vYear = vYearRaw != null ? parseInt(String(vYearRaw), 10) : undefined;
      const vFuel = (data.vehicle?.fuelType || data.fuelType)?.trim();
      const vType = (data.vehicle?.category || data.vehicleType)?.trim();

      let vehicleId = row.currentVehicleId || row.assignments?.[0]?.vehicleId;
      if (!vehicleId) {
        const linkedVehicle = await tx.vehicle.findFirst({
          where: { currentDriverId: id },
          select: { id: true },
        });
        vehicleId = linkedVehicle?.id;
      }

      if (!vehicleId && (vPlate || vMake || vModel)) {
        const plate = vPlate || `JK_${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
        const existingByPlate = await tx.vehicle.findUnique({
          where: { registrationNumber: plate },
        });
        if (existingByPlate) {
          vehicleId = existingByPlate.id;
          await tx.vehicle.update({
            where: { id: vehicleId },
            data: { currentDriverId: id },
          });
        } else {
          const defaultType = await tx.vehicleType.findFirst();
          if (defaultType) {
            const newVehicle = await tx.vehicle.create({
              data: {
                registrationNumber: plate,
                make: vMake || 'Vehicle',
                model: vModel || 'Model',
                color: vColor || 'White',
                vehicleTypeId: defaultType.id,
                currentDriverId: id,
                ...(vFuel ? { fuelType: vFuel } : {}),
                ...(vYear && !isNaN(vYear) ? { manufacturingYear: vYear } : {}),
              },
            });
            vehicleId = newVehicle.id;
          }
        }
      }

      if (vehicleId) {
        if (!row.currentVehicleId) {
          await tx.driver.update({
            where: { id },
            data: { currentVehicleId: vehicleId },
          });
        }

        const vehicleUpdates: Prisma.VehicleUpdateInput = {};
        if (vMake) vehicleUpdates.make = vMake;
        if (vModel) vehicleUpdates.model = vModel;
        if (vPlate) vehicleUpdates.registrationNumber = vPlate.toUpperCase();
        if (vColor) vehicleUpdates.color = vColor;
        if (vYear && !isNaN(vYear)) vehicleUpdates.manufacturingYear = vYear;
        if (vFuel) vehicleUpdates.fuelType = vFuel;

        if (vType) {
          const matchedType = await tx.vehicleType.findFirst({
            where: {
              OR: [
                { code: { equals: vType, mode: 'insensitive' } },
                { name: { contains: vType, mode: 'insensitive' } },
              ],
            },
          });
          if (matchedType) {
            vehicleUpdates.vehicleType = { connect: { id: matchedType.id } };
          }
        }

        if (Object.keys(vehicleUpdates).length > 0) {
          await tx.vehicle.update({
            where: { id: vehicleId },
            data: vehicleUpdates,
          });
        }
      }

      // 6. Update Bank Account
      const bName = (data.bankAccount?.bankName || data.bankName)?.trim();
      const bHolder = (data.bankAccount?.accountHolderName || data.accountHolderName)?.trim();
      const bNum = (data.bankAccount?.accountNumber || data.accountNumber)?.trim();
      const bIfsc = (data.bankAccount?.ifscCode || data.ifscCode)?.trim()?.toUpperCase();
      const bUpi = (data.bankAccount?.upiId || data.upiId)?.trim();

      if (bName || bHolder || bIfsc || bUpi || (bNum && !bNum.includes('•'))) {
        const existingAcc = row.bankAccounts?.[0];
        if (existingAcc) {
          const bankUpdates: Prisma.DriverBankAccountUpdateInput = {};
          if (bName) bankUpdates.bankName = bName;
          if (bHolder) bankUpdates.accountHolderName = bHolder;
          if (bIfsc) bankUpdates.ifscCode = bIfsc;
          if (bUpi) bankUpdates.upiId = bUpi;
          if (bNum && !bNum.includes('•')) {
            const clean = bNum.replace(/\D/g, '');
            bankUpdates.accountNumberLast4 =
              clean.length >= 4 ? clean.slice(-4) : clean.padStart(4, '0');
          }
          await tx.driverBankAccount.update({
            where: { id: existingAcc.id },
            data: bankUpdates,
          });
        } else {
          const clean = bNum ? bNum.replace(/\D/g, '') : '';
          const last4 =
            clean.length >= 4 ? clean.slice(-4) : clean ? clean.padStart(4, '0') : '0000';
          await tx.driverBankAccount.create({
            data: {
              driverId: id,
              bankName: bName || 'Bank',
              accountHolderName: bHolder || name || 'Account Holder',
              ifscCode: bIfsc || 'IFSC0000000',
              accountNumberLast4: last4,
              ...(bUpi ? { upiId: bUpi } : {}),
              isDefault: true,
              enteredBy: actor.actorId,
            },
          });
        }
      }

      // 7. Audit Log
      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'driver',
        entityId: id,
        summary: 'Driver profile updated by admin',
        notes: `Updated profile details for driver ${name || row.driverCode}`,
        result: 'SUCCESS',
      });
    });

    // 8. Moderation status change
    if (data.driverStatus) {
      const s = data.driverStatus.toLowerCase();
      if (s === 'suspended' || s === 'blocked' || s === 'active') {
        const current = await this.getById(id);
        if (current.driverStatus !== s) {
          await this.setModerationState(
            id,
            s as 'suspended' | 'blocked' | 'active',
            actor,
            `Driver status updated to ${s}`,
            'Updated via admin edit modal',
          ).catch(() => {});
        }
      }
    }

    return this.getById(id);
  }

  /// The driver flag, the account status, the session revocation and the audit row
  /// commit together or not at all. The driver row is locked before its state is read,
  /// so two concurrent requests cannot both pass the "already suspended" check and log
  /// the same transition twice.
  private async setModerationState(
    id: string,
    next: 'suspended' | 'blocked' | 'active',
    actor: AuditActor,
    summary: string,
    notes?: string,
  ): Promise<DriverDetailsDto> {
    const shouldSuspend = next !== 'active';
    const userId = await this.databaseService.transactionManager.execute(async (tx) => {
      await lockForAudit(tx, 'drivers', id);
      const row = await tx.driver.findFirst({
        where: { id, deletedAt: null },
        include: { user: true, onlineStatus: true },
      });
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

      if (row.isSuspended !== shouldSuspend) {
        await this.driverService.status.setSuspendedInTransaction(id, shouldSuspend, tx);
      }

      const nextUserStatus: UserStatus =
        next === 'blocked' ? 'DEACTIVATED' : next === 'suspended' ? 'SUSPENDED' : 'ACTIVE';
      if (row.user.status !== nextUserStatus) {
        await this.userRepository.updateStatus(row.userId, nextUserStatus, tx);
      }

      const sessionsRevoked = shouldSuspend
        ? await this.sessionService.revokeAllInTransaction(
            row.userId,
            next === 'blocked' ? 'blocked' : 'suspension',
            tx,
          )
        : 0;

      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'driver',
        entityId: id,
        summary,
        notes,
        before: { status: currentGate, isSuspended: row.isSuspended, userStatus: row.user.status },
        after: {
          status: next,
          isSuspended: shouldSuspend,
          userStatus: nextUserStatus,
          sessionsRevoked,
        },
        result: 'SUCCESS',
      });
      return row.userId;
    });

    // After commit, as `SessionService.logoutAll` does: retires the access tokens the
    // revoked sessions issued, and drops the driver from the dispatch geo index.
    if (shouldSuspend) {
      await this.epochService.bump(userId);
      await this.driverService.status.forgetPosition(id);
    }
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
        commissionWallet: true,
        onlineStatus: true,
        documents: {
          orderBy: { createdAt: 'asc' },
          include: {
            file: { select: { contentType: true, fileName: true } },
            backFile: { select: { contentType: true, fileName: true } },
          },
        },
        bankAccounts: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] },
        user: {
          include: {
            profile: true,
            emergencyContacts: { orderBy: { priority: 'asc' }, take: 1 },
          },
        },
        assignments: {
          where: { status: 'ACTIVE', releasedAt: null },
          take: 1,
          include: {
            vehicle: {
              include: {
                vehicleType: true,
                documents: {
                  include: {
                    file: { select: { contentType: true, fileName: true } },
                    backFile: { select: { contentType: true, fileName: true } },
                  },
                },
                images: { orderBy: { uploadedAt: 'desc' }, take: 1 },
              },
            },
          },
        },
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { plan: true },
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
    const driverDocs = row.documents ?? [];
    const vehicleDocs = vehicle?.documents ?? [];
    const documentsCount = driverDocs.length + vehicleDocs.length;
    const licenseDoc = driverDocs.find(
      (d) =>
        d.documentType === 'DRIVING_LICENSE' ||
        (d as unknown as { documentType: string }).documentType === 'LICENSE',
    );
    const insuranceDoc = vehicleDocs.find((d) => d.documentType?.toUpperCase() === 'INSURANCE');
    const permitDoc = vehicleDocs.find((d) => d.documentType?.toUpperCase() === 'PERMIT');

    const rawRow = row as {
      subscriptions?: Array<{
        status?: string;
        plan?: { name?: string };
        expiryDate?: Date;
      }>;
      commissionWallet?: { balance: Prisma.Decimal | number | string } | null;
      wallet?: { balance: Prisma.Decimal | number | string } | null;
      paymentModel?: string | null;
      pendingPaymentModel?: string | null;
    };
    const activeSub = rawRow.subscriptions?.[0];
    const commissionBal = rawRow.commissionWallet ? Number(rawRow.commissionWallet.balance) : 0;
    const earningsBal = rawRow.wallet ? Number(rawRow.wallet.balance) : 0;
    const effectiveBalance =
      rawRow.paymentModel === 'COMMISSION' || commissionBal > 0 ? commissionBal : earningsBal;

    return {
      id: row.id,
      driverCode: row.driverCode,
      applicationId: row.id,
      driverName: name,
      mobileNumber: row.user.phoneNumber,
      ...(row.user.email ? { email: row.user.email } : {}),
      vehicleType: mapVehicleTypeLabel(vehicle?.vehicleType?.code, vehicle?.vehicleType?.name),
      ...(vehicle?.registrationNumber ? { registrationPlate: vehicle.registrationNumber } : {}),
      ...(vehicle?.make ? { vehicleMake: vehicle.make } : {}),
      ...(vehicle?.model ? { vehicleModel: vehicle.model } : {}),
      ...(() => {
        if (!activeSub) return {};
        return {
          subscription: {
            status:
              activeSub.status === 'ACTIVE'
                ? 'active'
                : activeSub.status === 'EXPIRED'
                  ? 'expired'
                  : 'none',
            planName: activeSub.plan?.name ?? 'Active Plan',
            expiryDate: activeSub.expiryDate ? activeSub.expiryDate.toISOString() : undefined,
          },
        };
      })(),
      driverStatus,
      verificationStatus: row.verificationStatus,
      ...(row.rejectionReason != null ? { rejectionReason: row.rejectionReason } : {}),
      ratingAvg: Number(row.rating),
      totalTrips: row.totalRides,
      walletBalance: effectiveBalance,
      commissionWalletBalance: commissionBal,
      earningsBalance: earningsBal,
      ...(rawRow.paymentModel ? { paymentModel: rawRow.paymentModel } : {}),
      ...(rawRow.pendingPaymentModel ? { pendingPaymentModel: rawRow.pendingPaymentModel } : {}),
      ...(row.profile?.profilePhoto ? { profilePhotoUrl: row.profile.profilePhoto } : {}),
      documentsCount,
      ...(licenseDoc?.expiresAt
        ? { licenseExpiry: licenseDoc.expiresAt.toISOString().slice(0, 10) }
        : {}),
      ...(insuranceDoc?.expiresAt
        ? { insuranceExpiry: insuranceDoc.expiresAt.toISOString().slice(0, 10) }
        : {}),
      ...(permitDoc?.expiresAt
        ? { permitExpiry: permitDoc.expiresAt.toISOString().slice(0, 10) }
        : {}),
      joinedAt: row.createdAt.toISOString(),
      ...(row.lastRideAt ? { lastActiveAt: row.lastRideAt.toISOString() } : {}),
      isOnline: !isBlocked && (online === 'ONLINE' || online === 'ON_TRIP' || online === 'BUSY'),
      isSuspended: row.isSuspended && !isBlocked,
      isBlocked,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getExpiryAlerts(): Promise<{
    expired: number;
    d30: number;
    d60: number;
    d90: number;
    total: number;
  }> {
    const now = new Date();

    const [driverDocs, vehicleDocs] = await Promise.all([
      this.databaseService.client.driverDocument.findMany({
        where: { expiresAt: { not: null } },
        select: { expiresAt: true },
      }),
      this.databaseService.client.vehicleDocument.findMany({
        where: { expiresAt: { not: null } },
        select: { expiresAt: true },
      }),
    ]);

    let expired = 0;
    let d30 = 0;
    let d60 = 0;
    let d90 = 0;

    const allExpiries = [
      ...driverDocs.map((d) => d.expiresAt!),
      ...vehicleDocs.map((d) => d.expiresAt!),
    ];

    for (const exp of allExpiries) {
      const expDate = new Date(exp);
      const diffMs = expDate.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / 86400000);

      if (diffDays < 0) {
        expired++;
      } else if (diffDays <= 30) {
        d30++;
      } else if (diffDays <= 60) {
        d60++;
      } else if (diffDays <= 90) {
        d90++;
      }
    }

    return {
      expired,
      d30,
      d60,
      d90,
      total: allExpiries.length,
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
