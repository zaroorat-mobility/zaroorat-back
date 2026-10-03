import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { lockForAudit, recordAdminAction, type AuditActor } from '../../audit/index.js';
import { InvoiceNotFoundError, InvoiceTemplateNotFoundError } from '../pricing.errors.js';
import type {
  CreateInvoiceTemplateBody,
  ListInvoicesQuery,
  UpdateInvoiceTemplateBody,
} from './invoice.schemas.js';

function toNum(value: { toString(): string } | number): number {
  return typeof value === 'number' ? value : Number(value.toString());
}

export interface BillingInvoiceDto {
  id: string;
  invoiceNumber: string;
  bookingId: string | null;
  recipientName: string;
  recipientType: 'rider' | 'driver';
  date: string;
  amount: number;
  taxAmount: number;
  status: 'generated' | 'pending';
  hsnCode: string;
  fromRoute: string | null;
  toRoute: string | null;
  rideId: string | null;
  recipientUserId: string | null;
}

export interface InvoiceTemplateDto {
  id: string;
  name: string;
  headerLogoText: string;
  address: string;
  gstin: string;
  footerTerms: string;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  appliesTo: 'ride' | 'school' | 'services';
  isDefault: boolean;
}

function mapInvoice(row: {
  id: string;
  invoiceNumber: string;
  bookingCode: string | null;
  recipientName: string;
  recipientType: string;
  amount: { toString(): string };
  taxAmount: { toString(): string };
  status: string;
  hsnCode: string;
  fromRoute: string | null;
  toRoute: string | null;
  issuedAt: Date;
  rideId: string | null;
  recipientUserId: string | null;
}): BillingInvoiceDto {
  const recipientType = row.recipientType.toLowerCase() === 'driver' ? 'driver' : 'rider';
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    bookingId: row.bookingCode,
    recipientName: row.recipientName,
    recipientType,
    date: row.issuedAt.toISOString().slice(0, 10),
    amount: toNum(row.amount),
    taxAmount: toNum(row.taxAmount),
    status: row.status.toUpperCase() === 'PENDING' ? 'pending' : 'generated',
    hsnCode: row.hsnCode,
    fromRoute: row.fromRoute,
    toRoute: row.toRoute,
    rideId: row.rideId,
    recipientUserId: row.recipientUserId,
  };
}

function mapTemplate(row: {
  id: string;
  name: string;
  headerLogoText: string;
  address: string;
  gstin: string;
  footerTerms: string;
  cgstRate: { toString(): string };
  sgstRate: { toString(): string };
  igstRate: { toString(): string };
  appliesTo: string;
  isDefault: boolean;
}): InvoiceTemplateDto {
  const appliesTo = row.appliesTo as InvoiceTemplateDto['appliesTo'];
  return {
    id: row.id,
    name: row.name,
    headerLogoText: row.headerLogoText,
    address: row.address,
    gstin: row.gstin,
    footerTerms: row.footerTerms,
    cgstRate: toNum(row.cgstRate),
    sgstRate: toNum(row.sgstRate),
    igstRate: toNum(row.igstRate),
    appliesTo: appliesTo === 'school' || appliesTo === 'services' ? appliesTo : 'ride',
    isDefault: row.isDefault,
  };
}

export class AdminInvoiceService {
  constructor(private readonly db: DatabaseService) {}

  async listInvoices(query: ListInvoicesQuery) {
    const where: {
      recipientType?: string;
      OR?: Array<{
        recipientName?: { contains: string; mode: 'insensitive' };
        bookingCode?: { contains: string; mode: 'insensitive' };
        invoiceNumber?: { contains: string; mode: 'insensitive' };
      }>;
    } = {};

    if (query.recipientType && query.recipientType !== 'all') {
      where.recipientType = query.recipientType.toUpperCase();
    }

    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { recipientName: { contains: search, mode: 'insensitive' } },
        { bookingCode: { contains: search, mode: 'insensitive' } },
        { invoiceNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, totalCount] = await Promise.all([
      this.db.client.billingInvoice.findMany({
        where,
        orderBy: { issuedAt: 'desc' },
        skip,
        take: query.limit,
      }),
      this.db.client.billingInvoice.count({ where }),
    ]);

    return {
      data: rows.map(mapInvoice),
      meta: {
        currentPage: query.page,
        totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
        pageSize: query.limit,
        totalCount,
      },
    };
  }

  async getInvoiceById(id: string): Promise<BillingInvoiceDto> {
    const row = await this.db.client.billingInvoice.findUnique({ where: { id } });
    if (!row) throw new InvoiceNotFoundError(id);
    return mapInvoice(row);
  }

  async listTemplates(): Promise<InvoiceTemplateDto[]> {
    const rows = await this.db.client.invoiceTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return rows.map(mapTemplate);
  }

  async createTemplate(
    body: CreateInvoiceTemplateBody,
    actor: AuditActor,
  ): Promise<InvoiceTemplateDto> {
    return this.db.transactionManager.execute(async (tx) => {
      if (body.isDefault) await this.clearDefaults(tx, body.appliesTo, actor);
      const row = await tx.invoiceTemplate.create({
        data: {
          name: body.name,
          headerLogoText: body.headerLogoText,
          address: body.address,
          gstin: body.gstin,
          footerTerms: body.footerTerms,
          cgstRate: body.cgstRate,
          sgstRate: body.sgstRate,
          igstRate: body.igstRate,
          appliesTo: body.appliesTo,
          isDefault: body.isDefault ?? false,
        },
      });
      await recordAdminAction(tx, {
        ...actor,
        action: 'CREATE',
        entityType: 'invoice_template',
        entityId: row.id,
        summary: `Invoice template ${row.name} created`,
        after: row,
        result: 'SUCCESS',
      });
      return mapTemplate(row);
    });
  }

  async updateTemplate(
    id: string,
    body: UpdateInvoiceTemplateBody,
    actor: AuditActor,
  ): Promise<InvoiceTemplateDto> {
    return this.db.transactionManager.execute(async (tx) => {
      const existing = await this.lockTemplate(tx, id);
      if (body.isDefault) {
        await this.clearDefaults(tx, body.appliesTo ?? existing.appliesTo, actor, id);
      }
      const row = await tx.invoiceTemplate.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.headerLogoText !== undefined ? { headerLogoText: body.headerLogoText } : {}),
          ...(body.address !== undefined ? { address: body.address } : {}),
          ...(body.gstin !== undefined ? { gstin: body.gstin } : {}),
          ...(body.footerTerms !== undefined ? { footerTerms: body.footerTerms } : {}),
          ...(body.cgstRate !== undefined ? { cgstRate: body.cgstRate } : {}),
          ...(body.sgstRate !== undefined ? { sgstRate: body.sgstRate } : {}),
          ...(body.igstRate !== undefined ? { igstRate: body.igstRate } : {}),
          ...(body.appliesTo !== undefined ? { appliesTo: body.appliesTo } : {}),
          ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        },
      });
      await this.audit(tx, actor, 'UPDATE', existing, row, `Invoice template ${row.name} updated`);
      return mapTemplate(row);
    });
  }

  /// Soft delete: the row stays for the invoices that were issued against it.
  async deleteTemplate(id: string, actor: AuditActor): Promise<void> {
    await this.db.transactionManager.execute(async (tx) => {
      const existing = await this.lockTemplate(tx, id);
      const row = await tx.invoiceTemplate.update({
        where: { id },
        data: { isActive: false, isDefault: false },
      });
      await this.audit(tx, actor, 'DELETE', existing, row, `Invoice template ${row.name} deleted`);
    });
  }

  async setDefaultTemplate(id: string, actor: AuditActor): Promise<InvoiceTemplateDto> {
    return this.db.transactionManager.execute(async (tx) => {
      const existing = await this.lockTemplate(tx, id);
      await this.clearDefaults(tx, existing.appliesTo, actor, id);
      const row = await tx.invoiceTemplate.update({
        where: { id },
        data: { isDefault: true, isActive: true },
      });
      await this.audit(
        tx,
        actor,
        'UPDATE',
        existing,
        row,
        `Invoice template ${row.name} set as default`,
      );
      return mapTemplate(row);
    });
  }

  private async lockTemplate(tx: TransactionClient, id: string) {
    await lockForAudit(tx, 'invoice_templates', id);
    const existing = await tx.invoiceTemplate.findUnique({ where: { id } });
    if (!existing) throw new InvoiceTemplateNotFoundError(id);
    return existing;
  }

  private async audit(
    tx: TransactionClient,
    actor: AuditActor,
    action: 'UPDATE' | 'DELETE',
    before: { id: string },
    after: unknown,
    summary: string,
  ): Promise<void> {
    await recordAdminAction(tx, {
      ...actor,
      action,
      entityType: 'invoice_template',
      entityId: before.id,
      summary,
      before,
      after,
      result: 'SUCCESS',
    });
  }

  /// One default per `appliesTo`. A template that loses the flag is changed too, so it
  /// gets its own audit row in the same transaction.
  private async clearDefaults(
    tx: TransactionClient,
    appliesTo: string,
    actor: AuditActor,
    exceptId?: string,
  ): Promise<void> {
    const previous = await tx.invoiceTemplate.findMany({
      where: { appliesTo, isDefault: true, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    });
    for (const template of previous) {
      const row = await tx.invoiceTemplate.update({
        where: { id: template.id },
        data: { isDefault: false },
      });
      await this.audit(
        tx,
        actor,
        'UPDATE',
        template,
        row,
        `Invoice template ${row.name} is no longer the default`,
      );
    }
  }

  buildPreviewContext(
    invoice: BillingInvoiceDto,
    template: InvoiceTemplateDto,
  ): Record<string, string> {
    const totalGstRate = template.cgstRate + template.sgstRate + template.igstRate;
    const baseMultiplier = 1 + totalGstRate / 100;
    const taxableValue = invoice.amount / baseMultiplier;
    const gstAmount = invoice.amount - taxableValue;
    const cgstAmount = taxableValue * (template.cgstRate / 100);
    const sgstAmount = taxableValue * (template.sgstRate / 100);

    return {
      invoice_number: invoice.invoiceNumber,
      invoice_date: invoice.date,
      customer_name:
        invoice.recipientType === 'rider' ? invoice.recipientName : 'Zaroorat Mobility',
      customer_contact: '',
      driver_name: invoice.recipientType === 'driver' ? invoice.recipientName : 'Demo Driver',
      driver_id: 'DRV0001',
      trip_id: invoice.bookingId ?? '',
      booking_id: invoice.bookingId ?? '',
      fare_breakdown: `₹${taxableValue.toFixed(2)} (base) + ₹${gstAmount.toFixed(2)} (GST)`,
      total_amount: `₹${invoice.amount.toFixed(2)}`,
      amount_in_words: `${invoice.amount.toFixed(2)} Rupees Only`,
      commission_amount:
        invoice.recipientType === 'driver'
          ? `₹${invoice.amount.toFixed(2)}`
          : `₹${(invoice.amount * 0.07).toFixed(2)}`,
      subscription_plan: '—',
      subscription_amount: '—',
      tax_breakdown: `CGST: ₹${cgstAmount.toFixed(2)} | SGST: ₹${sgstAmount.toFixed(2)} | IGST: ₹0.00`,
      company_gstin: template.gstin,
      company_address: template.address,
    };
  }
}
