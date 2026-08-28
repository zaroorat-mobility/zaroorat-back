import { z } from 'zod';

export const listInvoicesQuerySchema = z.object({
  recipientType: z.enum(['rider', 'driver', 'all']).optional().default('all'),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const invoiceIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const createInvoiceTemplateBodySchema = z.object({
  name: z.string().min(1).max(200),
  headerLogoText: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
  gstin: z.string().min(1).max(20),
  footerTerms: z.string().min(1).max(2000),
  cgstRate: z.coerce.number().min(0).max(100).default(2.5),
  sgstRate: z.coerce.number().min(0).max(100).default(2.5),
  igstRate: z.coerce.number().min(0).max(100).default(0),
  appliesTo: z.enum(['ride', 'school', 'services']).default('ride'),
  isDefault: z.boolean().optional().default(false),
});

export const updateInvoiceTemplateBodySchema = createInvoiceTemplateBodySchema.partial();

export const invoiceTemplateIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
export type CreateInvoiceTemplateBody = z.infer<typeof createInvoiceTemplateBodySchema>;
export type UpdateInvoiceTemplateBody = z.infer<typeof updateInvoiceTemplateBodySchema>;
