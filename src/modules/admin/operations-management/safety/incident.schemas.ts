import { z } from 'zod';

export const listSafetyIncidentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z
    .enum(['all', 'OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'CLOSED'])
    .optional()
    .default('all'),
  type: z
    .enum(['all', 'SOS', 'MISCONDUCT', 'ACCIDENT', 'LOST_FOUND', 'OTHER'])
    .optional()
    .default('all'),
  severity: z.enum(['all', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().default('all'),
  rideId: z.string().uuid().optional(),
  reporterUserId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
});

export type ListSafetyIncidentsQuery = z.infer<typeof listSafetyIncidentsQuerySchema>;

export const incidentIdParamSchema = z.object({
  id: z.string().min(1),
});

export type IncidentIdParam = z.infer<typeof incidentIdParamSchema>;

export const createSafetyIncidentBodySchema = z.object({
  type: z.enum(['SOS', 'MISCONDUCT', 'ACCIDENT', 'LOST_FOUND', 'OTHER']).optional().default('SOS'),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().default('HIGH'),
  rideId: z.string().uuid().optional(),
  reporterUserId: z.string().uuid().optional(),
  reporterPhone: z.string().optional(),
  subjectUserId: z.string().uuid().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  locationAddress: z.string().trim().max(300).optional(),
  description: z.string().trim().min(3).max(5000),
  evidenceFileIds: z.array(z.string()).optional().default([]),
});

export type CreateSafetyIncidentBody = z.infer<typeof createSafetyIncidentBodySchema>;

export const acknowledgeIncidentBodySchema = z.object({
  notes: z.string().trim().max(1000).optional(),
});

export type AcknowledgeIncidentBody = z.infer<typeof acknowledgeIncidentBodySchema>;

export const resolveIncidentBodySchema = z.object({
  resolutionType: z.string().trim().min(1).max(100).default('RESOLVED'),
  resolutionNotes: z.string().trim().min(1).max(2000),
  status: z.enum(['RESOLVED', 'CLOSED']).optional().default('RESOLVED'),
});

export type ResolveIncidentBody = z.infer<typeof resolveIncidentBodySchema>;

export const escalateIncidentBodySchema = z.object({
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().default('CRITICAL'),
  notes: z.string().trim().min(1).max(1000),
});

export type EscalateIncidentBody = z.infer<typeof escalateIncidentBodySchema>;

export const addIncidentNoteBodySchema = z.object({
  notes: z.string().trim().min(1).max(2000),
});

export type AddIncidentNoteBody = z.infer<typeof addIncidentNoteBodySchema>;

export const attachEvidenceBodySchema = z.object({
  fileId: z.string().min(1),
});

export type AttachEvidenceBody = z.infer<typeof attachEvidenceBodySchema>;
