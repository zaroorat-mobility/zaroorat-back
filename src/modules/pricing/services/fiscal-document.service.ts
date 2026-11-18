import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@config';
import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { logger } from '@shared/logger/index.js';
import {
  PricingGovernanceError,
  REV5_PRICING_FLAGS,
  type FeatureFlagReader,
} from '../constants.js';
import {
  BuiltinPdf14Renderer,
  type FiscalDocumentPdfInput,
  type FiscalPdfLineItem,
  type FiscalPdfRenderer,
} from './fiscal-pdf.renderer.js';

export const FISCAL_DOCUMENT_TYPES = [
  'PASSENGER_TAX_INVOICE',
  'COMMISSION_TAX_INVOICE',
  'DRIVER_SETTLEMENT_STATEMENT',
  'CREDIT_NOTE',
  'SUBSCRIPTION_INVOICE',
] as const;

export type FiscalDocumentType = (typeof FISCAL_DOCUMENT_TYPES)[number];

export const SUPPORTED_COMPLIANCE_PLACEHOLDERS = new Set<string>([
  'invoice_number',
  'invoice_date',
  'customer_name',
  'customer_contact',
  'driver_name',
  'driver_id',
  'trip_id',
  'booking_id',
  'fare_breakdown',
  'total_amount',
  'amount_in_words',
  'commission_amount',
  'gst_recovery_amount',
  'subscription_plan',
  'subscription_amount',
  'tax_breakdown',
  'sac_code',
  'company_gstin',
  'company_legal_name',
  'company_address',
  'supplier_state_code',
  'place_of_supply_state_code',
]);

export function validateCompliancePlaceholders(content: string): string[] {
  const unknown = new Set<string>();
  for (const match of content.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const key = match[1];
    if (key && !SUPPORTED_COMPLIANCE_PLACEHOLDERS.has(key)) {
      unknown.add(key);
    }
  }
  return [...unknown];
}

/// Computes Indian Financial Year (April 1 – March 31) in `YYYY-YY` format, e.g. `2026-27`.
export function getIndianFinancialYear(date: Date): string {
  // Use IST (+05:30) boundary so March 31 23:59 IST stays in the prior FY
  const istMs = date.getTime() + 330 * 60_000;
  const ist = new Date(istMs);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0-indexed (0 = Jan, 3 = Apr)
  const startYear = month >= 3 ? year : year - 1;
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endShort}`;
}

/// RFC-4180 CSV escaping with spreadsheet formula-injection neutralization.
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function computeDocumentSha256(canonicalPayload: Record<string, unknown>): string {
  const keys = Object.keys(canonicalPayload).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = canonicalPayload[k];
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function toNum(v: { toString(): string } | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class FiscalDocumentNotFoundError extends PricingGovernanceError {
  constructor(id: string) {
    super(`Fiscal document ${id} not found`, 'FISCAL_DOCUMENT_NOT_FOUND', 404);
    this.name = 'FiscalDocumentNotFoundError';
  }
}

export class DocumentSeriesMissingError extends PricingGovernanceError {
  constructor(detail: string) {
    super(`No active document series found: ${detail}`, 'DOCUMENT_SERIES_MISSING', 503);
    this.name = 'DocumentSeriesMissingError';
  }
}

export class FiscalDownloadTokenInvalidError extends PricingGovernanceError {
  constructor(reason = 'Invalid or expired download token') {
    super(reason, 'FISCAL_DOWNLOAD_TOKEN_INVALID', 403);
    this.name = 'FiscalDownloadTokenInvalidError';
  }
}

export interface FiscalDocumentDto {
  id: string;
  documentNumber: string;
  seriesId: string;
  sequenceNumber: number;
  documentType: FiscalDocumentType;
  status: 'ISSUED' | 'VOIDED';
  rideId: string | null;
  rideCode: string | null;
  recipientUserId: string | null;
  recipientType: 'RIDER' | 'DRIVER';
  recipientName: string;
  legalEntityId: string;
  gstRegistrationId: string;
  supplierLegalName: string;
  supplierGstin: string;
  supplierStateCode: string;
  placeOfSupplyStateCode: string;
  isInterState: boolean;
  sacCode: string | null;
  currency: string;
  taxableValue: number;
  nonTaxableValue: number;
  cgstRatePct: number;
  sgstRatePct: number;
  igstRatePct: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalTaxAmount: number;
  totalAmount: number;
  lineItems: FiscalPdfLineItem[];
  snapshotRefs: Record<string, unknown>;
  templateId: string | null;
  contentSha256: string;
  issuedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface IssueRideDocumentsResult {
  skipped?: 'FLAG_OFF' | 'RIDE_NOT_COMPLETED' | 'GRANDFATHERED_SUBSCRIPTION';
  documents: FiscalDocumentDto[];
}

export class FiscalDocumentService {
  private readonly pdfRenderer: FiscalPdfRenderer;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly featureFlagService: FeatureFlagReader,
    fiscalPdfRenderer: FiscalPdfRenderer = new BuiltinPdf14Renderer(),
  ) {
    this.pdfRenderer = fiscalPdfRenderer;
  }

  private getSigningKey(): Buffer {
    return createHash('sha256')
      .update(`zaroorat:fiscal-doc-download:v1:${config.jwt.accessSecret}`)
      .digest();
  }

  async isIssuanceEnabled(): Promise<boolean> {
    if (!this.featureFlagService) return false;
    return this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.DOCUMENTS_ISSUE);
  }

  createSignedDownloadToken(
    documentId: string,
    actorId: string,
    ttlSeconds = 300,
  ): { token: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payloadJson = JSON.stringify({ docId: documentId, actorId, exp });
    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
    const sigB64 = createHmac('sha256', this.getSigningKey())
      .update(payloadB64)
      .digest('base64url');
    return {
      token: `${payloadB64}.${sigB64}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  verifySignedDownloadToken(documentId: string, token: string): { actorId: string } {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new FiscalDownloadTokenInvalidError();
    }
    const [payloadB64, sigB64] = parts;
    const expectedSig = createHmac('sha256', this.getSigningKey())
      .update(payloadB64)
      .digest();
    let providedSig: Buffer;
    try {
      providedSig = Buffer.from(sigB64, 'base64url');
    } catch {
      throw new FiscalDownloadTokenInvalidError();
    }
    if (
      providedSig.length !== expectedSig.length ||
      !timingSafeEqual(providedSig, expectedSig)
    ) {
      throw new FiscalDownloadTokenInvalidError();
    }

    let parsed: { docId?: string; actorId?: string; exp?: number };
    try {
      parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
        docId?: string;
        actorId?: string;
        exp?: number;
      };
    } catch {
      throw new FiscalDownloadTokenInvalidError();
    }

    if (
      parsed.docId !== documentId ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Math.floor(Date.now() / 1000) ||
      typeof parsed.actorId !== 'string'
    ) {
      throw new FiscalDownloadTokenInvalidError('Download token expired or mismatched');
    }
    return { actorId: parsed.actorId };
  }

  /// Idempotent outbox handler for `ride.completed`.
  /// Strictly gated behind `documents.issue` (default OFF).
  async issueForCompletedRide(rideId: string): Promise<IssueRideDocumentsResult> {
    const enabled = await this.isIssuanceEnabled();
    if (!enabled) {
      return { skipped: 'FLAG_OFF', documents: [] };
    }

    const ride = await this.databaseService.client.ride.findUnique({
      where: { id: rideId },
      include: {
        fare: true,
        request: true,
        customer: { include: { profile: true } },
        driver: { include: { user: { include: { profile: true } } } },
      },
    });
    if (!ride || ride.status !== 'COMPLETED' || !ride.fare) {
      return { skipped: 'RIDE_NOT_COMPLETED', documents: [] };
    }

    // Rev 5 R5-2: Never accidentally recognize passenger GST on Path A grandfathered rides
    if (ride.driverPaymentModel === 'SUBSCRIPTION' && !ride.passengerGstSnapshot) {
      return { skipped: 'GRANDFATHERED_SUBSCRIPTION', documents: [] };
    }

    const issuedAt = ride.completedAt ?? new Date();
    const fy = getIndianFinancialYear(issuedAt);
    const gstSnap = (ride.passengerGstSnapshot as Record<string, unknown> | null) ?? null;
    const commSnap = (ride.commissionSnapshot as Record<string, unknown> | null) ?? null;
    const recSnap = (ride.gstRecoverySnapshot as Record<string, unknown> | null) ?? null;
    const pricingSnap = (ride.request.pricingSnapshot as Record<string, unknown> | null) ?? null;

    const cityCode =
      (typeof pricingSnap?.cityCode === 'string' && pricingSnap.cityCode) ||
      (typeof gstSnap?.cityCode === 'string' && gstSnap.cityCode) ||
      'GLOBAL';

    const formatProfileName = (
      profile: { firstName: string | null; lastName: string | null } | null | undefined,
    ): string | null => {
      if (!profile) return null;
      const joined = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
      return joined || null;
    };

    const supplyReg = await this.resolveSupplyRegistration(cityCode, gstSnap, issuedAt);
    const customerName =
      ride.passengerName ||
      formatProfileName(ride.customer.profile) ||
      ride.customer.phoneNumber ||
      'Rider';
    const driverName =
      formatProfileName(ride.driver.user.profile) || ride.driver.user.phoneNumber || 'Driver';

    const issuedDocs: FiscalDocumentDto[] = [];

    // 1. Passenger Tax Invoice (copying snapshot SAC, jurisdiction & tax breakdown verbatim)
    const passengerDoc = await this.issueSingleDocumentInTx({
      rideId: ride.id,
      rideCode: ride.rideCode,
      documentType: 'PASSENGER_TAX_INVOICE',
      financialYear: fy,
      issuedAt,
      recipientType: 'RIDER',
      recipientUserId: ride.customerId,
      recipientName: customerName,
      legalEntityId: supplyReg.legalEntityId,
      gstRegistrationId: supplyReg.gstRegistrationId,
      supplierLegalName: supplyReg.legalEntityName,
      supplierGstin: supplyReg.gstin,
      supplierStateCode:
        (typeof gstSnap?.supplierStateCode === 'string' && gstSnap.supplierStateCode) ||
        supplyReg.stateCode,
      placeOfSupplyStateCode:
        (typeof gstSnap?.placeOfSupplyStateCode === 'string' && gstSnap.placeOfSupplyStateCode) ||
        supplyReg.stateCode,
      isInterState: Boolean(gstSnap?.isInterState ?? false),
      // ZERO default '9964': only copies CA-approved SAC code locked in the ride snapshot
      sacCode: typeof gstSnap?.sacCode === 'string' ? gstSnap.sacCode : null,
      currency: ride.fare.currency || 'INR',
      taxableValue:
        gstSnap?.taxableValue != null
          ? round2(Number(gstSnap.taxableValue))
          : round2(toNum(ride.fare.totalFare) - toNum(ride.fare.taxAmount)),
      nonTaxableValue:
        gstSnap?.nonTaxableValue != null ? round2(Number(gstSnap.nonTaxableValue)) : 0,
      cgstRatePct: gstSnap?.cgstRatePct != null ? round2(Number(gstSnap.cgstRatePct)) : 0,
      sgstRatePct: gstSnap?.sgstRatePct != null ? round2(Number(gstSnap.sgstRatePct)) : 0,
      igstRatePct: gstSnap?.igstRatePct != null ? round2(Number(gstSnap.igstRatePct)) : 0,
      cgstAmount: gstSnap?.cgstAmount != null ? round2(Number(gstSnap.cgstAmount)) : 0,
      sgstAmount: gstSnap?.sgstAmount != null ? round2(Number(gstSnap.sgstAmount)) : 0,
      igstAmount: gstSnap?.igstAmount != null ? round2(Number(gstSnap.igstAmount)) : 0,
      totalTaxAmount:
        gstSnap?.taxAmount != null
          ? round2(Number(gstSnap.taxAmount))
          : round2(toNum(ride.fare.taxAmount)),
      totalAmount: round2(toNum(ride.fare.totalFare)),
      lineItems: this.buildPassengerLineItems(ride.fare),
      snapshotRefs: {
        rideCode: ride.rideCode,
        pricingRuleId: pricingSnap?.pricingRuleId ?? ride.request.pricingRuleId ?? null,
        taxConfigId: gstSnap?.configId ?? null,
        taxConfigVersion: gstSnap?.version ?? null,
        waitingTaxable: gstSnap?.waitingTaxable ?? null,
        inclusive: gstSnap?.inclusive ?? null,
      },
    });
    if (passengerDoc) issuedDocs.push(passengerDoc);

    // 2. Driver Settlement Statement (if an active series is configured for this registration)
    const driverSeriesExists = await this.databaseService.client.documentSeries.findFirst({
      where: {
        gstRegistrationId: supplyReg.gstRegistrationId,
        documentType: 'DRIVER_SETTLEMENT_STATEMENT',
        financialYear: fy,
        isActive: true,
      },
    });
    if (driverSeriesExists) {
      const commAmount =
        commSnap?.commissionAmount != null
          ? round2(Number(commSnap.commissionAmount))
          : round2(toNum(ride.commissionAmount));
      const recAmount =
        recSnap?.recoveryAmount != null ? round2(Number(recSnap.recoveryAmount)) : 0;
      const driverDoc = await this.issueSingleDocumentInTx({
        rideId: ride.id,
        rideCode: ride.rideCode,
        documentType: 'DRIVER_SETTLEMENT_STATEMENT',
        financialYear: fy,
        issuedAt,
        recipientType: 'DRIVER',
        recipientUserId: ride.driver.userId,
        recipientName: driverName,
        legalEntityId: supplyReg.legalEntityId,
        gstRegistrationId: supplyReg.gstRegistrationId,
        supplierLegalName: supplyReg.legalEntityName,
        supplierGstin: supplyReg.gstin,
        supplierStateCode: supplyReg.stateCode,
        placeOfSupplyStateCode:
          (typeof gstSnap?.placeOfSupplyStateCode === 'string' && gstSnap.placeOfSupplyStateCode) ||
          supplyReg.stateCode,
        isInterState: false,
        sacCode: null,
        currency: ride.fare.currency || 'INR',
        taxableValue: round2(commAmount + recAmount),
        nonTaxableValue: 0,
        cgstRatePct: 0,
        sgstRatePct: 0,
        igstRatePct: 0,
        cgstAmount: 0,
        sgstAmount: 0,
        igstAmount: 0,
        totalTaxAmount: 0,
        totalAmount: round2(commAmount + recAmount),
        lineItems: [
          {
            label: 'Gross Ride Fare Collected by Driver',
            amount: round2(toNum(ride.fare.totalFare)),
          },
          {
            label: 'Platform Commission Wallet Debit',
            amount: commAmount,
            ...(commSnap?.commissionRatePct != null
              ? { note: `${Number(commSnap.commissionRatePct)}%` }
              : {}),
          },
          ...(recAmount > 0
            ? [
                {
                  label: 'Passenger GST Recovery Wallet Debit',
                  amount: recAmount,
                  ...(recSnap?.recoveryRatePct != null
                    ? { note: `${Number(recSnap.recoveryRatePct)}%` }
                    : {}),
                },
              ]
            : []),
        ],
        snapshotRefs: {
          rideCode: ride.rideCode,
          commissionConfigId: commSnap?.configId ?? null,
          gstRecoveryConfigId: recSnap?.configId ?? null,
          driverPaymentModel: ride.driverPaymentModel,
        },
      });
      if (driverDoc) issuedDocs.push(driverDoc);
    }

    return { documents: issuedDocs };
  }

  private async resolveSupplyRegistration(
    cityCode: string,
    gstSnap: Record<string, unknown> | null,
    at: Date,
  ): Promise<{
    legalEntityId: string;
    legalEntityName: string;
    gstRegistrationId: string;
    gstin: string;
    stateCode: string;
  }> {
    if (typeof gstSnap?.gstRegistrationId === 'string') {
      const reg = await this.databaseService.client.companyGstRegistration.findUnique({
        where: { id: gstSnap.gstRegistrationId },
        include: { legalEntity: true },
      });
      if (reg) {
        return {
          legalEntityId: reg.legalEntityId,
          legalEntityName: reg.legalEntity.legalEntityName,
          gstRegistrationId: reg.id,
          gstin: reg.gstin,
          stateCode: reg.stateCode,
        };
      }
    }

    const mapping = await this.databaseService.client.citySupplyRegistration.findFirst({
      where: {
        cityCode,
        supplyKind: 'PASSENGER_RIDE',
        isActive: true,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      include: { legalEntity: true, gstRegistration: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (mapping) {
      return {
        legalEntityId: mapping.legalEntityId,
        legalEntityName: mapping.legalEntity.legalEntityName,
        gstRegistrationId: mapping.gstRegistrationId,
        gstin: mapping.gstRegistration.gstin,
        stateCode: mapping.gstRegistration.stateCode,
      };
    }

    throw new DocumentSeriesMissingError(
      `No active city_supply_registrations mapping for city '${cityCode}'`,
    );
  }

  private buildPassengerLineItems(fare: {
    baseFare: { toString(): string };
    distanceFare: { toString(): string };
    timeFare: { toString(): string };
    waitingCharge: { toString(): string };
    surgeAmount: { toString(): string };
    discountAmount: { toString(): string };
  }): FiscalPdfLineItem[] {
    const items: FiscalPdfLineItem[] = [
      { label: 'Base Fare', amount: round2(toNum(fare.baseFare)) },
      { label: 'Distance Fare', amount: round2(toNum(fare.distanceFare)) },
      { label: 'Time Fare', amount: round2(toNum(fare.timeFare)) },
    ];
    const surge = round2(toNum(fare.surgeAmount));
    if (surge > 0) items.push({ label: 'Surge Adjustment', amount: surge });
    const waiting = round2(toNum(fare.waitingCharge));
    if (waiting > 0) items.push({ label: 'Waiting Charges', amount: waiting });
    const discount = round2(toNum(fare.discountAmount));
    if (discount > 0) items.push({ label: 'Promotional Discount', amount: -discount });
    return items;
  }

  private async issueSingleDocumentInTx(params: {
    rideId: string;
    rideCode: string;
    documentType: FiscalDocumentType;
    financialYear: string;
    issuedAt: Date;
    recipientType: 'RIDER' | 'DRIVER';
    recipientUserId: string;
    recipientName: string;
    legalEntityId: string;
    gstRegistrationId: string;
    supplierLegalName: string;
    supplierGstin: string;
    supplierStateCode: string;
    placeOfSupplyStateCode: string;
    isInterState: boolean;
    sacCode: string | null;
    currency: string;
    taxableValue: number;
    nonTaxableValue: number;
    cgstRatePct: number;
    sgstRatePct: number;
    igstRatePct: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    totalTaxAmount: number;
    totalAmount: number;
    lineItems: FiscalPdfLineItem[];
    snapshotRefs: Record<string, unknown>;
  }): Promise<FiscalDocumentDto | null> {
    return this.databaseService.transactionManager.execute(async (tx: TransactionClient) => {
      // Idempotency check BEFORE acquiring/incrementing series sequence so redelivery never burns a number!
      const existing = await tx.fiscalDocument.findFirst({
        where: { rideId: params.rideId, documentType: params.documentType },
      });
      if (existing) {
        return this.toDto(existing);
      }

      // Row-level FOR UPDATE lock on the active series guarantees gapless monotonic numbering under concurrency
      const seriesRows = await tx.$queryRaw<
        Array<{ id: string; prefix: string; last_sequence: bigint | number | string }>
      >`
        SELECT "id", "prefix", "last_sequence"
        FROM "document_series"
        WHERE "gst_registration_id" = ${params.gstRegistrationId}::uuid
          AND "document_type" = ${params.documentType}
          AND "financial_year" = ${params.financialYear}
          AND "is_active" = true
        FOR UPDATE
      `;
      const series = seriesRows[0];
      if (!series) {
        throw new DocumentSeriesMissingError(
          `gstRegistration=${params.gstRegistrationId}, type=${params.documentType}, fy=${params.financialYear}`,
        );
      }

      // Double-check inside the series lock in case a parallel worker won the race on the same ride
      const raced = await tx.fiscalDocument.findFirst({
        where: { rideId: params.rideId, documentType: params.documentType },
      });
      if (raced) {
        return this.toDto(raced);
      }

      const nextSeq = BigInt(series.last_sequence) + 1n;
      await tx.$executeRaw`
        UPDATE "document_series"
        SET "last_sequence" = ${nextSeq}, "updated_at" = now()
        WHERE "id" = ${series.id}::uuid
      `;

      const documentNumber = `${series.prefix}${String(nextSeq).padStart(6, '0')}`;

      const activeTemplate = await tx.complianceTemplate.findFirst({
        where: { documentType: params.documentType, isActive: true },
        select: { id: true },
      });

      const contentSha256 = computeDocumentSha256({
        documentNumber,
        documentType: params.documentType,
        rideId: params.rideId,
        supplierGstin: params.supplierGstin,
        supplierStateCode: params.supplierStateCode,
        placeOfSupplyStateCode: params.placeOfSupplyStateCode,
        sacCode: params.sacCode,
        taxableValue: params.taxableValue,
        nonTaxableValue: params.nonTaxableValue,
        cgstAmount: params.cgstAmount,
        sgstAmount: params.sgstAmount,
        igstAmount: params.igstAmount,
        totalTaxAmount: params.totalTaxAmount,
        totalAmount: params.totalAmount,
      });

      const created = await tx.fiscalDocument.create({
        data: {
          documentNumber,
          seriesId: series.id,
          sequenceNumber: nextSeq,
          documentType: params.documentType,
          status: 'ISSUED',
          rideId: params.rideId,
          recipientUserId: params.recipientUserId,
          recipientType: params.recipientType,
          recipientName: params.recipientName,
          legalEntityId: params.legalEntityId,
          gstRegistrationId: params.gstRegistrationId,
          supplierLegalName: params.supplierLegalName,
          supplierGstin: params.supplierGstin,
          supplierStateCode: params.supplierStateCode,
          placeOfSupplyStateCode: params.placeOfSupplyStateCode,
          isInterState: params.isInterState,
          sacCode: params.sacCode,
          currency: params.currency,
          taxableValue: params.taxableValue,
          nonTaxableValue: params.nonTaxableValue,
          cgstRatePct: params.cgstRatePct,
          sgstRatePct: params.sgstRatePct,
          igstRatePct: params.igstRatePct,
          cgstAmount: params.cgstAmount,
          sgstAmount: params.sgstAmount,
          igstAmount: params.igstAmount,
          totalTaxAmount: params.totalTaxAmount,
          totalAmount: params.totalAmount,
          lineItemsJson: params.lineItems as unknown as object,
          snapshotRefsJson: params.snapshotRefs as unknown as object,
          templateId: activeTemplate?.id ?? null,
          contentSha256,
          issuedAt: params.issuedAt,
        },
      });

      logger.info(
        {
          documentId: created.id,
          documentNumber,
          documentType: params.documentType,
          rideId: params.rideId,
        },
        '[fiscal-document] issued immutable document',
      );
      return this.toDto(created);
    });
  }

  async getById(id: string): Promise<FiscalDocumentDto> {
    const row = await this.databaseService.client.fiscalDocument.findUnique({ where: { id } });
    if (!row) throw new FiscalDocumentNotFoundError(id);
    return this.toDto(row);
  }

  async renderPdfBuffer(id: string): Promise<{
    buffer: Buffer;
    fileName: string;
    document: FiscalDocumentDto;
  }> {
    const doc = await this.getById(id);
    const pdfInput: FiscalDocumentPdfInput = {
      documentNumber: doc.documentNumber,
      documentType: doc.documentType,
      status: doc.status,
      issuedAtIso: doc.issuedAt,
      rideCode: doc.rideCode,
      recipientType: doc.recipientType,
      recipientName: doc.recipientName,
      supplierLegalName: doc.supplierLegalName,
      supplierGstin: doc.supplierGstin,
      supplierStateCode: doc.supplierStateCode,
      placeOfSupplyStateCode: doc.placeOfSupplyStateCode,
      isInterState: doc.isInterState,
      sacCode: doc.sacCode,
      currency: doc.currency,
      taxableValue: doc.taxableValue,
      nonTaxableValue: doc.nonTaxableValue,
      cgstRatePct: doc.cgstRatePct,
      sgstRatePct: doc.sgstRatePct,
      igstRatePct: doc.igstRatePct,
      cgstAmount: doc.cgstAmount,
      sgstAmount: doc.sgstAmount,
      igstAmount: doc.igstAmount,
      totalTaxAmount: doc.totalTaxAmount,
      totalAmount: doc.totalAmount,
      lineItems: doc.lineItems,
      contentSha256: doc.contentSha256,
    };
    const buffer = await this.pdfRenderer.render(pdfInput);
    const safeFileName = `${doc.documentNumber.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
    return { buffer, fileName: safeFileName, document: doc };
  }

  async listForRideParticipant(
    rideId: string,
    userId: string,
  ): Promise<Array<FiscalDocumentDto & { downloadPath: string; expiresAt: string }>> {
    const ride = await this.databaseService.client.ride.findUnique({
      where: { id: rideId },
      select: {
        id: true,
        customerId: true,
        driver: { select: { userId: true } },
      },
    });
    if (!ride) return [];

    const isRider = ride.customerId === userId;
    const isDriver = ride.driver.userId === userId;
    if (!isRider && !isDriver) {
      throw new PricingGovernanceError(
        'Not authorized to access fiscal documents for this ride',
        'FORBIDDEN',
        403,
      );
    }

    const allowedRecipientTypes: Array<'RIDER' | 'DRIVER'> = [];
    if (isRider) allowedRecipientTypes.push('RIDER');
    if (isDriver) allowedRecipientTypes.push('DRIVER');

    const rows = await this.databaseService.client.fiscalDocument.findMany({
      where: {
        rideId,
        recipientType: { in: allowedRecipientTypes },
      },
      orderBy: { issuedAt: 'desc' },
    });

    return rows.map((row) => {
      const dto = this.toDto(row);
      const { token, expiresAt } = this.createSignedDownloadToken(dto.id, userId, 300);
      return {
        ...dto,
        downloadPath: `/api/v1/fiscal-documents/${dto.id}/download?token=${encodeURIComponent(token)}`,
        expiresAt,
      };
    });
  }

  toDto(row: {
    id: string;
    documentNumber: string;
    seriesId: string;
    sequenceNumber: bigint;
    documentType: string;
    status: string;
    rideId: string | null;
    recipientUserId: string | null;
    recipientType: string;
    recipientName: string;
    legalEntityId: string;
    gstRegistrationId: string;
    supplierLegalName: string;
    supplierGstin: string;
    supplierStateCode: string;
    placeOfSupplyStateCode: string;
    isInterState: boolean;
    sacCode: string | null;
    currency: string;
    taxableValue: { toString(): string };
    nonTaxableValue: { toString(): string };
    cgstRatePct: { toString(): string };
    sgstRatePct: { toString(): string };
    igstRatePct: { toString(): string };
    cgstAmount: { toString(): string };
    sgstAmount: { toString(): string };
    igstAmount: { toString(): string };
    totalTaxAmount: { toString(): string };
    totalAmount: { toString(): string };
    lineItemsJson: unknown;
    snapshotRefsJson: unknown;
    templateId: string | null;
    contentSha256: string;
    issuedAt: Date;
    voidedAt: Date | null;
    voidReason: string | null;
  }): FiscalDocumentDto {
    const refs = (row.snapshotRefsJson as Record<string, unknown> | null) ?? {};
    const items = Array.isArray(row.lineItemsJson)
      ? (row.lineItemsJson as FiscalPdfLineItem[])
      : [];
    return {
      id: row.id,
      documentNumber: row.documentNumber,
      seriesId: row.seriesId,
      sequenceNumber: Number(row.sequenceNumber),
      documentType: row.documentType as FiscalDocumentType,
      status: row.status === 'VOIDED' ? 'VOIDED' : 'ISSUED',
      rideId: row.rideId,
      rideCode: typeof refs.rideCode === 'string' ? refs.rideCode : null,
      recipientUserId: row.recipientUserId,
      recipientType: row.recipientType === 'DRIVER' ? 'DRIVER' : 'RIDER',
      recipientName: row.recipientName,
      legalEntityId: row.legalEntityId,
      gstRegistrationId: row.gstRegistrationId,
      supplierLegalName: row.supplierLegalName,
      supplierGstin: row.supplierGstin,
      supplierStateCode: row.supplierStateCode,
      placeOfSupplyStateCode: row.placeOfSupplyStateCode,
      isInterState: row.isInterState,
      sacCode: row.sacCode,
      currency: row.currency,
      taxableValue: toNum(row.taxableValue),
      nonTaxableValue: toNum(row.nonTaxableValue),
      cgstRatePct: toNum(row.cgstRatePct),
      sgstRatePct: toNum(row.sgstRatePct),
      igstRatePct: toNum(row.igstRatePct),
      cgstAmount: toNum(row.cgstAmount),
      sgstAmount: toNum(row.sgstAmount),
      igstAmount: toNum(row.igstAmount),
      totalTaxAmount: toNum(row.totalTaxAmount),
      totalAmount: toNum(row.totalAmount),
      lineItems: items,
      snapshotRefs: refs,
      templateId: row.templateId,
      contentSha256: row.contentSha256,
      issuedAt: row.issuedAt.toISOString(),
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidReason: row.voidReason,
    };
  }
}
