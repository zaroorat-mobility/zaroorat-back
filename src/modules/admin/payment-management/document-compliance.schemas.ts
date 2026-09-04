import { z } from 'zod';

export const listDocumentComplianceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  complianceState: z
    .enum(['all', 'compliant', 'expiring_soon', 'non_compliant', 'incomplete'])
    .optional()
    .default('all'),
  alertThresholdDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const complianceDriverParamSchema = z.object({
  driverId: z.string().uuid(),
});

export const reviewDocumentBodySchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED', 'PENDING']),
  rejectionReason: z.string().trim().max(1000).optional(),
});

export const reviewDocumentParamSchema = z.object({
  documentId: z.string().uuid(),
});

export const documentSettingsBodySchema = z.object({
  alertThresholdDays: z.coerce.number().int().min(1).max(365),
  notifyEmail: z.boolean(),
  notifyPush: z.boolean(),
});

export type ListDocumentComplianceQuery = z.infer<typeof listDocumentComplianceQuerySchema>;
export type DocumentSettingsBody = z.infer<typeof documentSettingsBodySchema>;
