import { randomUUID } from 'node:crypto';
import { DatabaseService } from '@core/database';
import {
  BuiltinPdf14Renderer,
  computeDocumentSha256,
  escapeCsvCell,
  FiscalDocumentNotFoundError,
  FiscalDocumentService,
  PricingGovernanceError,
  validateCompliancePlaceholders,
  type FiscalDocumentDto,
  type FiscalDocumentPdfInput,
  type FiscalDocumentType,
  type FiscalPdfLineItem,
} from '@modules/pricing';
import { recordAdminAction, type AuditActor } from '../../audit/index.js';
import type {
  CreateComplianceTemplateBody,
  CreateDocumentSeriesBody,
  ExportFiscalDocumentsQuery,
  ListFiscalDocumentsQuery,
  PreviewSamplePdfBody,
  VoidFiscalDocumentBody,
} from './fiscal.schemas.js';

export interface DocumentSeriesDto {
  id: string;
  gstRegistrationId: string;
  gstin: string;
  stateCode: string;
  stateName: string;
  legalEntityName: string;
  documentType: FiscalDocumentType;
  financialYear: string;
  prefix: string;
  lastSequence: number;
  isActive: boolean;
  createdAt: string;
}

export interface ComplianceTemplateDto {
  id: string;
  familyId: string;
  version: number;
  documentType: FiscalDocumentType;
  name: string;
  fileName: string;
  mimeType: string;
  content: string;
  versionNote: string | null;
  effectiveFrom: string;
  previewApproved: boolean;
  previewApprovedBy: string | null;
  previewApprovedAt: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
}

export class AdminFiscalDocumentService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly fiscalDocumentService: FiscalDocumentService,
  ) {}

  private buildWhere(query: {
    documentType?: FiscalDocumentType | undefined;
    recipientType?: string | undefined;
    status?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    search?: string | undefined;
  }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (query.documentType) {
      where.documentType = query.documentType;
    }
    if (query.recipientType && query.recipientType !== 'all') {
      where.recipientType = query.recipientType.toUpperCase();
    }
    if (query.status && query.status !== 'all') {
      where.status = query.status;
    }
    if (query.from || query.to) {
      where.issuedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    const q = query.search?.trim();
    if (q) {
      where.OR = [
        { documentNumber: { contains: q, mode: 'insensitive' } },
        { recipientName: { contains: q, mode: 'insensitive' } },
        { supplierGstin: { contains: q, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async listDocuments(query: ListFiscalDocumentsQuery) {
    const where = this.buildWhere(query);
    const skip = (query.page - 1) * query.limit;
    const [rows, totalCount] = await Promise.all([
      this.databaseService.client.fiscalDocument.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip,
        take: query.limit,
      }),
      this.databaseService.client.fiscalDocument.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.fiscalDocumentService.toDto(r)),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getDocumentById(id: string): Promise<FiscalDocumentDto> {
    return this.fiscalDocumentService.getById(id);
  }

  async createSignedDownloadUrl(
    id: string,
    actor: AuditActor,
  ): Promise<{ downloadPath: string; expiresAt: string; documentNumber: string }> {
    const doc = await this.fiscalDocumentService.getById(id);
    const { token, expiresAt } = this.fiscalDocumentService.createSignedDownloadToken(
      doc.id,
      actor.actorId,
      300,
    );
    return {
      downloadPath: `/api/v1/fiscal-documents/${doc.id}/download?token=${encodeURIComponent(token)}`,
      expiresAt,
      documentNumber: doc.documentNumber,
    };
  }

  async renderPdfBuffer(id: string) {
    return this.fiscalDocumentService.renderPdfBuffer(id);
  }

  /// Renders a live, non-persisted sample PDF using the active built-in production PDF renderer
  /// and the live Legal Entity, State GSTIN, Tax/Commission %, and Series Prefix from PostgreSQL.
  /// Never increments any document_series sequence and never writes to fiscal_documents.
  async renderSamplePdfBuffer(body: PreviewSamplePdfBody): Promise<{
    buffer: Buffer;
    fileName: string;
  }> {
    const docType = body.documentType ?? 'PASSENGER_TAX_INVOICE';

    const [gstReg, activeSeries, activePassengerGst, activeCommissionGst, activeCommission] =
      await Promise.all([
        body.gstRegistrationId
          ? this.databaseService.client.companyGstRegistration.findUnique({
              where: { id: body.gstRegistrationId },
              include: { legalEntity: true },
            })
          : this.databaseService.client.companyGstRegistration.findFirst({
              where: { isActive: true },
              include: { legalEntity: true },
              orderBy: { createdAt: 'desc' },
            }),
        this.databaseService.client.documentSeries.findFirst({
          where: {
            documentType: docType,
            isActive: true,
            ...(body.gstRegistrationId ? { gstRegistrationId: body.gstRegistrationId } : {}),
          },
          orderBy: { createdAt: 'desc' },
        }),
        this.databaseService.client.taxConfiguration.findFirst({
          where: { kind: 'PASSENGER_RIDE_GST', status: 'ACTIVE', isEnabled: true },
          orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
        }),
        this.databaseService.client.taxConfiguration.findFirst({
          where: { kind: 'COMMISSION_GST', status: 'ACTIVE', isEnabled: true },
          orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
        }),
        this.databaseService.client.commissionConfiguration.findFirst({
          where: { status: 'ACTIVE', isEnabled: true },
          orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
        }),
      ]);

    const supplierLegalName =
      gstReg?.legalEntity?.legalEntityName ?? 'Zaroorat Mobility (Configure Legal Entity)';
    const supplierAddress = gstReg?.legalEntity?.headOfficeAddress ?? null;
    const supplierGstin = gstReg?.gstin ?? 'UNCONFIGURED-GSTIN';
    const supplierStateCode = gstReg?.stateCode ?? '01';
    const placeOfSupplyStateCode = body.placeOfSupplyStateCode ?? supplierStateCode;
    const isInterState =
      docType === 'WALLET_RECHARGE_RECEIPT' ? false : supplierStateCode !== placeOfSupplyStateCode;

    const passengerGstPct = activePassengerGst ? Number(activePassengerGst.ratePct) : 5;
    const commissionGstPct = activeCommissionGst ? Number(activeCommissionGst.ratePct) : 18;
    const commissionPct = activeCommission ? Number(activeCommission.commissionRatePct) : 15;

    let recipientType: 'RIDER' | 'DRIVER' = 'RIDER';
    let recipientName = 'Sample Rider';
    let sacCode: string | null;
    let taxRatePct: number;
    let lineItems: FiscalPdfLineItem[];
    let taxableValue: number;
    let nonTaxableValue = 0;
    let rideOrPaymentRef = 'RIDE-SAMPLE-001';

    if (docType === 'PASSENGER_TAX_INVOICE') {
      lineItems = [
        { label: 'Base Fare', amount: 40 },
        { label: 'Distance Charge (5.0 km)', amount: 60 },
        { label: 'Ride Time Charge (12 min)', amount: 12 },
        { label: 'Waiting Charge (2 min billable)', amount: 8 },
      ];
      taxableValue = 120;
      sacCode = activePassengerGst?.sacCode ?? '996411';
      taxRatePct = passengerGstPct;
    } else if (docType === 'COMMISSION_TAX_INVOICE') {
      recipientType = 'DRIVER';
      recipientName = 'Sample Driver Partner';
      const commissionAmt = Math.round(200 * (commissionPct / 100) * 100) / 100;
      lineItems = [
        {
          label: `Platform Commission (${commissionPct.toFixed(2)}% on INR 200.00 fare)`,
          amount: commissionAmt,
        },
      ];
      taxableValue = commissionAmt;
      sacCode = activeCommissionGst?.sacCode ?? '998599';
      taxRatePct = commissionGstPct;
    } else if (docType === 'WALLET_RECHARGE_RECEIPT') {
      recipientType = 'DRIVER';
      recipientName = 'Sample Driver Partner';
      rideOrPaymentRef = 'UPI-REF-SAMPLE-500';
      lineItems = [
        {
          label: 'Commission Wallet Prepaid Recharge (UPI / Online)',
          amount: 500,
          note: 'Updated Wallet Balance: INR 625.00',
        },
      ];
      taxableValue = 0;
      nonTaxableValue = 500;
      sacCode = null;
      taxRatePct = 0;
    } else if (docType === 'DRIVER_SETTLEMENT_STATEMENT') {
      recipientType = 'DRIVER';
      recipientName = 'Sample Driver Partner';
      const commAmt = Math.round(200 * (commissionPct / 100) * 100) / 100;
      const gstRecoveryAmt = Math.round(200 * (passengerGstPct / 100) * 100) / 100;
      lineItems = [
        { label: 'Gross Ride Fare Collected', amount: 200 },
        { label: `Platform Commission (${commissionPct.toFixed(2)}%)`, amount: -commAmt },
        { label: `Ride GST Recovery (${passengerGstPct.toFixed(2)}%)`, amount: -gstRecoveryAmt },
      ];
      taxableValue = Math.round((200 - commAmt - gstRecoveryAmt) * 100) / 100;
      sacCode = activeCommissionGst?.sacCode ?? '998599';
      taxRatePct = 0;
    } else if (docType === 'CREDIT_NOTE') {
      lineItems = [{ label: 'Fare Adjustment / Credit Refund', amount: 25 }];
      taxableValue = 25;
      sacCode = activePassengerGst?.sacCode ?? '996411';
      taxRatePct = passengerGstPct;
    } else {
      recipientType = 'DRIVER';
      recipientName = 'Sample Driver Partner';
      lineItems = [{ label: 'Driver Weekly Subscription Plan', amount: 499 }];
      taxableValue = 499;
      sacCode = activeCommissionGst?.sacCode ?? '998599';
      taxRatePct = commissionGstPct;
    }

    const totalTaxAmount = Math.round(taxableValue * (taxRatePct / 100) * 100) / 100;
    const cgstRatePct = isInterState ? 0 : Math.round((taxRatePct / 2) * 100) / 100;
    const sgstRatePct = isInterState ? 0 : Math.round((taxRatePct / 2) * 100) / 100;
    const igstRatePct = isInterState ? taxRatePct : 0;
    const cgstAmount = isInterState ? 0 : Math.round((totalTaxAmount / 2) * 100) / 100;
    const sgstAmount = isInterState ? 0 : Math.round((totalTaxAmount - cgstAmount) * 100) / 100;
    const igstAmount = isInterState ? totalTaxAmount : 0;
    const totalAmount = Math.round((taxableValue + nonTaxableValue + totalTaxAmount) * 100) / 100;

    const documentNumber = activeSeries
      ? `${activeSeries.prefix}SAMPLE`
      : `PREVIEW-${docType.slice(0, 3)}-000001`;
    const issuedAtIso = new Date().toISOString();
    const contentSha256 = computeDocumentSha256({
      preview: true,
      documentNumber,
      documentType: docType,
      supplierGstin,
      taxableValue,
      nonTaxableValue,
      totalTaxAmount,
      totalAmount,
    });

    const renderer = new BuiltinPdf14Renderer();
    const pdfInput: FiscalDocumentPdfInput = {
      documentNumber,
      documentType: docType,
      status: 'ISSUED',
      issuedAtIso,
      rideCode: rideOrPaymentRef,
      recipientType,
      recipientName,
      supplierLegalName,
      supplierAddress,
      supplierGstin,
      supplierStateCode,
      placeOfSupplyStateCode,
      isInterState,
      sacCode,
      currency: 'INR',
      taxableValue,
      nonTaxableValue,
      cgstRatePct,
      sgstRatePct,
      igstRatePct,
      cgstAmount,
      sgstAmount,
      igstAmount,
      totalTaxAmount,
      totalAmount,
      lineItems,
      contentSha256,
      footerNotice:
        'SAMPLE PREVIEW ONLY — Rendered live with active Legal Entity, GSTIN, and GST settings. No sequence consumed.',
    };

    const buffer = await renderer.render(pdfInput);
    const fileName = `zaroorat-sample-${docType.toLowerCase()}.pdf`;
    return { buffer, fileName };
  }

  async voidDocument(
    id: string,
    body: VoidFiscalDocumentBody,
    actor: AuditActor,
  ): Promise<FiscalDocumentDto> {
    return this.databaseService.transactionManager.execute(async (tx) => {
      const existing = await tx.fiscalDocument.findUnique({ where: { id } });
      if (!existing) throw new FiscalDocumentNotFoundError(id);
      if (existing.status === 'VOIDED') {
        throw new PricingGovernanceError(
          `Fiscal document ${existing.documentNumber} is already VOIDED`,
          'FISCAL_DOCUMENT_ALREADY_VOIDED',
          409,
        );
      }

      const updated = await tx.fiscalDocument.update({
        where: { id },
        data: {
          status: 'VOIDED',
          voidReason: body.reason,
          voidedBy: actor.actorId,
          voidedAt: new Date(),
        },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'fiscal_document',
        entityId: updated.id,
        summary: `Voided fiscal document ${updated.documentNumber}: ${body.reason}`,
        before: { status: existing.status },
        after: { status: updated.status, voidReason: body.reason },
        result: 'SUCCESS',
      });

      return this.fiscalDocumentService.toDto(updated);
    });
  }

  /// Audited Finance CSV export (RFC-4180 + formula-injection protection + mandatory audit row).
  async exportCsv(
    query: ExportFiscalDocumentsQuery,
    actor: AuditActor,
  ): Promise<{ csv: string; fileName: string; rowCount: number }> {
    const where = this.buildWhere(query);
    const rows = await this.databaseService.client.fiscalDocument.findMany({
      where,
      orderBy: { issuedAt: 'desc' },
      take: 10_000,
    });

    const headers = [
      'Document Number',
      'Document Type',
      'Status',
      'Issued At (UTC)',
      'Ride Code',
      'Recipient Type',
      'Recipient Name',
      'Supplier Legal Name',
      'Supplier GSTIN',
      'Supplier State',
      'Place of Supply State',
      'Supply Type',
      'SAC Code',
      'Currency',
      'Taxable Value',
      'Non-Taxable Value',
      'CGST Rate %',
      'CGST Amount',
      'SGST Rate %',
      'SGST Amount',
      'IGST Rate %',
      'IGST Amount',
      'Total Tax',
      'Total Amount',
      'Content SHA-256',
    ];

    const lines: string[] = [headers.map(escapeCsvCell).join(',')];
    for (const row of rows) {
      const dto = this.fiscalDocumentService.toDto(row);
      lines.push(
        [
          dto.documentNumber,
          dto.documentType,
          dto.status,
          dto.issuedAt,
          dto.rideCode ?? '',
          dto.recipientType,
          dto.recipientName,
          dto.supplierLegalName,
          dto.supplierGstin,
          dto.supplierStateCode,
          dto.placeOfSupplyStateCode,
          dto.isInterState ? 'INTER_STATE' : 'INTRA_STATE',
          dto.sacCode ?? '',
          dto.currency,
          dto.taxableValue.toFixed(2),
          dto.nonTaxableValue.toFixed(2),
          dto.cgstRatePct.toFixed(2),
          dto.cgstAmount.toFixed(2),
          dto.sgstRatePct.toFixed(2),
          dto.sgstAmount.toFixed(2),
          dto.igstRatePct.toFixed(2),
          dto.igstAmount.toFixed(2),
          dto.totalTaxAmount.toFixed(2),
          dto.totalAmount.toFixed(2),
          dto.contentSha256,
        ]
          .map(escapeCsvCell)
          .join(','),
      );
    }

    await this.databaseService.transactionManager.execute(async (tx) => {
      await recordAdminAction(tx, {
        ...actor,
        action: 'EXPORT',
        entityType: 'fiscal_document',
        summary: `Exported ${rows.length} fiscal document(s) to CSV`,
        after: {
          rowCount: rows.length,
          filters: query,
        },
        result: 'SUCCESS',
      });
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return {
      csv: `${lines.join('\r\n')}\r\n`,
      fileName: `zaroorat-fiscal-documents-${stamp}.csv`,
      rowCount: rows.length,
    };
  }

  // ─── Document Series Management ────────────────────────────────────────────

  async listDocumentSeries(): Promise<DocumentSeriesDto[]> {
    const rows = await this.databaseService.client.documentSeries.findMany({
      include: {
        gstRegistration: {
          include: { legalEntity: true },
        },
      },
      orderBy: [{ financialYear: 'desc' }, { documentType: 'asc' }],
    });

    return rows.map((r) => ({
      id: r.id,
      gstRegistrationId: r.gstRegistrationId,
      gstin: r.gstRegistration.gstin,
      stateCode: r.gstRegistration.stateCode,
      stateName: r.gstRegistration.stateName,
      legalEntityName: r.gstRegistration.legalEntity.legalEntityName,
      documentType: r.documentType as FiscalDocumentType,
      financialYear: r.financialYear,
      prefix: r.prefix,
      lastSequence: Number(r.lastSequence),
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createDocumentSeries(
    body: CreateDocumentSeriesBody,
    actor: AuditActor,
  ): Promise<DocumentSeriesDto> {
    return this.databaseService.transactionManager.execute(async (tx) => {
      const reg = await tx.companyGstRegistration.findUnique({
        where: { id: body.gstRegistrationId },
        include: { legalEntity: true },
      });
      if (!reg || !reg.isActive) {
        throw new PricingGovernanceError(
          'Active company_gst_registrations record required for document series',
          'GST_REGISTRATION_NOT_FOUND',
          404,
        );
      }

      const duplicate = await tx.documentSeries.findFirst({
        where: {
          OR: [
            {
              gstRegistrationId: body.gstRegistrationId,
              documentType: body.documentType,
              financialYear: body.financialYear,
            },
            {
              prefix: body.prefix,
              financialYear: body.financialYear,
            },
          ],
        },
      });
      if (duplicate) {
        throw new PricingGovernanceError(
          `Document series already exists for prefix '${body.prefix}' or (${reg.gstin}, ${body.documentType}, FY ${body.financialYear})`,
          'DOCUMENT_SERIES_CONFLICT',
          409,
        );
      }

      const created = await tx.documentSeries.create({
        data: {
          gstRegistrationId: body.gstRegistrationId,
          documentType: body.documentType,
          financialYear: body.financialYear,
          prefix: body.prefix,
          lastSequence: 0n,
          isActive: true,
          createdBy: actor.actorId,
        },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'document_series',
        entityId: created.id,
        summary: `Created document series ${created.prefix} (${created.documentType}, FY ${created.financialYear}) for ${reg.gstin}`,
        after: {
          ...created,
          lastSequence: Number(created.lastSequence),
        },
        result: 'SUCCESS',
      });

      return {
        id: created.id,
        gstRegistrationId: created.gstRegistrationId,
        gstin: reg.gstin,
        stateCode: reg.stateCode,
        stateName: reg.stateName,
        legalEntityName: reg.legalEntity.legalEntityName,
        documentType: created.documentType as FiscalDocumentType,
        financialYear: created.financialYear,
        prefix: created.prefix,
        lastSequence: Number(created.lastSequence),
        isActive: created.isActive,
        createdAt: created.createdAt.toISOString(),
      };
    });
  }

  // ─── Persisted CR-03 Compliance Templates ──────────────────────────────────

  async listComplianceTemplates(
    documentType?: FiscalDocumentType,
  ): Promise<ComplianceTemplateDto[]> {
    const rows = await this.databaseService.client.complianceTemplate.findMany({
      ...(documentType ? { where: { documentType } } : {}),
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => this.mapComplianceTemplate(r));
  }

  async createComplianceTemplate(
    body: CreateComplianceTemplateBody,
    actor: AuditActor,
  ): Promise<ComplianceTemplateDto> {
    const unknownPlaceholders = validateCompliancePlaceholders(body.content);
    if (unknownPlaceholders.length > 0) {
      throw new PricingGovernanceError(
        `Unsupported template placeholder(s): ${unknownPlaceholders.map((p) => `{{${p}}}`).join(', ')}`,
        'INVALID_TEMPLATE_PLACEHOLDERS',
        400,
      );
    }

    return this.databaseService.transactionManager.execute(async (tx) => {
      const familyId = body.familyId ?? randomUUID();
      const latest = await tx.complianceTemplate.aggregate({
        where: { familyId },
        _max: { version: true },
      });
      const version = (latest._max.version ?? 0) + 1;

      const created = await tx.complianceTemplate.create({
        data: {
          familyId,
          version,
          documentType: body.documentType,
          name: body.name,
          fileName: body.fileName,
          mimeType: body.mimeType,
          content: body.content,
          versionNote: body.versionNote ?? null,
          effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
          previewApproved: false,
          isActive: false,
          createdBy: actor.actorId,
        },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'compliance_template',
        entityId: created.id,
        summary: `Uploaded compliance template '${created.name}' v${created.version} (${created.documentType})`,
        after: {
          id: created.id,
          name: created.name,
          documentType: created.documentType,
          version: created.version,
          fileName: created.fileName,
        },
        result: 'SUCCESS',
      });

      return this.mapComplianceTemplate(created);
    });
  }

  async approveComplianceTemplatePreview(
    id: string,
    actor: AuditActor,
  ): Promise<ComplianceTemplateDto> {
    return this.databaseService.transactionManager.execute(async (tx) => {
      const existing = await tx.complianceTemplate.findUnique({ where: { id } });
      if (!existing) {
        throw new PricingGovernanceError(
          `Compliance template ${id} not found`,
          'COMPLIANCE_TEMPLATE_NOT_FOUND',
          404,
        );
      }

      const updated = await tx.complianceTemplate.update({
        where: { id },
        data: {
          previewApproved: true,
          previewApprovedBy: actor.actorId,
          previewApprovedAt: new Date(),
        },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'APPROVE',
        entityType: 'compliance_template',
        entityId: updated.id,
        summary: `Approved preview for compliance template '${updated.name}' v${updated.version}`,
        before: { previewApproved: existing.previewApproved },
        after: { previewApproved: true },
        result: 'SUCCESS',
      });

      return this.mapComplianceTemplate(updated);
    });
  }

  async activateComplianceTemplate(id: string, actor: AuditActor): Promise<ComplianceTemplateDto> {
    return this.databaseService.transactionManager.execute(async (tx) => {
      const target = await tx.complianceTemplate.findUnique({ where: { id } });
      if (!target) {
        throw new PricingGovernanceError(
          `Compliance template ${id} not found`,
          'COMPLIANCE_TEMPLATE_NOT_FOUND',
          404,
        );
      }
      if (!target.previewApproved) {
        throw new PricingGovernanceError(
          `Compliance template ${id} cannot be activated before preview approval`,
          'TEMPLATE_PREVIEW_NOT_APPROVED',
          409,
        );
      }
      await tx.complianceTemplate.updateMany({
        where: { documentType: target.documentType, isActive: true, NOT: { id: target.id } },
        data: { isActive: false },
      });

      const activated = await tx.complianceTemplate.update({
        where: { id: target.id },
        data: {
          isActive: true,
        },
      });

      await recordAdminAction(tx, {
        ...actor,
        action: 'UPDATE',
        entityType: 'compliance_template',
        entityId: activated.id,
        summary: `Activated compliance template '${activated.name}' v${activated.version} for ${activated.documentType}`,
        before: { isActive: target.isActive },
        after: { isActive: true },
        result: 'SUCCESS',
      });

      return this.mapComplianceTemplate(activated);
    });
  }

  private mapComplianceTemplate(row: {
    id: string;
    familyId: string;
    version: number;
    documentType: string;
    name: string;
    fileName: string;
    mimeType: string;
    content: string;
    versionNote: string | null;
    effectiveFrom: Date;
    previewApproved: boolean;
    previewApprovedBy: string | null;
    previewApprovedAt: Date | null;
    isActive: boolean;
    createdBy: string;
    createdAt: Date;
  }): ComplianceTemplateDto {
    return {
      id: row.id,
      familyId: row.familyId,
      version: row.version,
      documentType: row.documentType as FiscalDocumentType,
      name: row.name,
      fileName: row.fileName,
      mimeType: row.mimeType,
      content: row.content,
      versionNote: row.versionNote,
      effectiveFrom: row.effectiveFrom.toISOString(),
      previewApproved: row.previewApproved,
      previewApprovedBy: row.previewApprovedBy,
      previewApprovedAt: row.previewApprovedAt?.toISOString() ?? null,
      isActive: row.isActive,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
