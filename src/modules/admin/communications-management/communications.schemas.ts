import { z } from 'zod';

export const notificationChannelSchema = z.enum(['PUSH', 'SMS', 'EMAIL', 'IN_APP', 'WHATSAPP']);

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const listTemplatesQuerySchema = paginationQuerySchema.extend({
  channel: notificationChannelSchema.optional(),
  eventKey: z.string().trim().min(1).max(120).optional(),
  isActive: z
    .enum(['true', 'false', 'all'])
    .optional()
    .default('all')
    .transform((value) => (value === 'all' ? undefined : value === 'true')),
});

export const createTemplateBodySchema = z.object({
  eventKey: z.string().trim().min(2).max(120),
  channel: notificationChannelSchema,
  subject: z.string().trim().max(500).optional().nullable(),
  body: z.string().trim().min(1).max(5000),
  variables: z.array(z.string().trim().min(1).max(80)).optional().default([]),
  isActive: z.boolean().optional().default(true),
});

export const updateTemplateBodySchema = createTemplateBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field must be provided',
  });

export const deliveryHistoryQuerySchema = paginationQuerySchema.extend({
  channel: notificationChannelSchema.optional(),
  status: z.enum(['PENDING', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'READ']).optional(),
});

export const broadcastTargetingSchema = z
  .object({
    userIds: z.array(z.string().uuid()).optional(),
    roles: z.array(z.string().trim().min(1).max(50)).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => Boolean(value.all || value.userIds?.length || value.roles?.length), {
    message: 'Targeting must include userIds, roles, or all=true',
  });

export const sendPushBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  targeting: broadcastTargetingSchema,
  templateId: z.string().uuid().optional(),
  data: z.record(z.string(), z.string()).optional(),
});

export const schedulePushBodySchema = sendPushBodySchema.extend({
  scheduledAt: z.coerce.date().refine((date) => date.getTime() > Date.now(), {
    message: 'scheduledAt must be in the future',
  }),
});

export const pushHistoryQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED']).optional(),
});

export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;
export type CreateTemplateBody = z.infer<typeof createTemplateBodySchema>;
export type UpdateTemplateBody = z.infer<typeof updateTemplateBodySchema>;
export type DeliveryHistoryQuery = z.infer<typeof deliveryHistoryQuerySchema>;
export type SendPushBody = z.infer<typeof sendPushBodySchema>;
export type SchedulePushBody = z.infer<typeof schedulePushBodySchema>;
export type PushHistoryQuery = z.infer<typeof pushHistoryQuerySchema>;
export type BroadcastTargeting = z.infer<typeof broadcastTargetingSchema>;
