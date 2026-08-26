import { z } from 'zod';

export const listApplicationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional(),
  status: z
    .enum(['all', 'pending_review', 'under_review', 'rejected', 'resubmission_required'])
    .optional()
    .default('all'),
});

export const applicationIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const applicationNotesBodySchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export const applicationDocumentParamSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
});

export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;
