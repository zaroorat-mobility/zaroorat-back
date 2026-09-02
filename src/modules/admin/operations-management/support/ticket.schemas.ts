import { z } from 'zod';

export const listSupportTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z
    .enum(['all', 'OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED', 'REOPENED'])
    .optional()
    .default('all'),
  priority: z.enum(['all', 'LOW', 'NORMAL', 'HIGH', 'URGENT']).optional().default('all'),
  categoryId: z.string().uuid().optional(),
  rideId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  assignedAgentId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
});

export type ListSupportTicketsQuery = z.infer<typeof listSupportTicketsQuerySchema>;

export const ticketIdParamSchema = z.object({
  id: z.string().min(1),
});

export type TicketIdParam = z.infer<typeof ticketIdParamSchema>;

export const createSupportTicketBodySchema = z.object({
  userId: z.string().uuid().optional(),
  userPhoneNumber: z.string().optional(),
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).optional(),
  categoryId: z.string().uuid().optional(),
  categoryCode: z.string().optional(),
  rideId: z.string().uuid().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional().default('NORMAL'),
  channel: z.enum(['APP', 'EMAIL', 'PHONE', 'CHAT', 'SOCIAL']).optional().default('APP'),
});

export type CreateSupportTicketBody = z.infer<typeof createSupportTicketBodySchema>;

export const assignTicketBodySchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type AssignTicketBody = z.infer<typeof assignTicketBodySchema>;

export const updateTicketStatusBodySchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED', 'REOPENED']),
  notes: z.string().trim().max(1000).optional(),
});

export type UpdateTicketStatusBody = z.infer<typeof updateTicketStatusBodySchema>;

export const addTicketMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(5000),
  isInternal: z.boolean().optional().default(false),
  authorType: z.enum(['AGENT', 'SYSTEM', 'CUSTOMER']).optional().default('AGENT'),
  attachments: z.any().optional(),
});

export type AddTicketMessageBody = z.infer<typeof addTicketMessageBodySchema>;

export const resolveTicketBodySchema = z.object({
  resolutionNotes: z.string().trim().min(1).max(2000),
  status: z.enum(['RESOLVED', 'CLOSED']).optional().default('RESOLVED'),
});

export type ResolveTicketBody = z.infer<typeof resolveTicketBodySchema>;
