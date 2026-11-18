import { z } from 'zod';
import { FISCAL_DOCUMENT_TYPES } from '@modules/pricing';

export const fiscalDocIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const fiscalDocumentTypeSchema = z.enum(FISCAL_DOCUMENT_TYPES);

export const listFiscalDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  documentType: fiscalDocumentTypeSchema.optional(),
  recipientType: z.enum(['all', 'RIDER', 'DRIVER', 'rider', 'driver']).optional().default('all'),
  status: z.enum(['all', 'ISSUED', 'VOIDED']).optional().default('all'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  search: z.string().trim().max(120).optional(),
});

export const exportFiscalDocumentsQuerySchema = z.object({
  documentType: fiscalDocumentTypeSchema.optional(),
  recipientType: z.enum(['all', 'RIDER', 'DRIVER', 'rider', 'driver']).optional().default('all'),
  status: z.enum(['all', 'ISSUED', 'VOIDED']).optional().default('all'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  search: z.string().trim().max(120).optional(),
});

export const voidFiscalDocumentBodySchema = z
  .object({
    reason: z.string().trim().min(5).max(300),
  })
  .strict();

export const createDocumentSeriesBodySchema = z
  .object({
    gstRegistrationId: z.string().uuid(),
    documentType: fiscalDocumentTypeSchema,
    financialYear: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}$/, 'Financial year must match YYYY-YY (e.g. 2026-27)'),
    prefix: z
      .string()
      .trim()
      .min(2)
      .max(24)
      .regex(/^[A-Z0-9/_-]+$/, 'Prefix may contain uppercase letters, digits, /, _, -'),
  })
  .strict();

export const createComplianceTemplateBodySchema = z
  .object({
    documentType: fiscalDocumentTypeSchema,
    name: z.string().trim().min(2).max(120),
    fileName: z.string().trim().min(3).max(160),
    mimeType: z.enum(['text/html', 'text/plain']).optional().default('text/html'),
    content: z.string().min(10).max(200_000),
    versionNote: z.string().trim().max(300).optional().nullable(),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    familyId: z.string().uuid().optional(),
  })
  .strict();

export type ListFiscalDocumentsQuery = z.infer<typeof listFiscalDocumentsQuerySchema>;
export type ExportFiscalDocumentsQuery = z.infer<typeof exportFiscalDocumentsQuerySchema>;
export type VoidFiscalDocumentBody = z.infer<typeof voidFiscalDocumentBodySchema>;
export type CreateDocumentSeriesBody = z.infer<typeof createDocumentSeriesBodySchema>;
export type CreateComplianceTemplateBody = z.infer<typeof createComplianceTemplateBodySchema>;
