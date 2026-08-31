import { z } from 'zod';

export const queueNameParamSchema = z.object({
  name: z.string().min(1),
});

export const queueJobParamsSchema = z.object({
  queue: z.string().min(1),
  jobId: z.string().min(1),
});

export const listQueueJobsQuerySchema = z.object({
  status: z
    .enum(['waiting', 'active', 'delayed', 'failed', 'completed'])
    .optional()
    .default('waiting'),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const jobActionBodySchema = z.object({
  action: z.enum(['retry', 'remove']),
});
