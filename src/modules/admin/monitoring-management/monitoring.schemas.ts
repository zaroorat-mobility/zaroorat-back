import { z } from 'zod';

export const listErrorsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const ackAlertParamsSchema = z.object({
  id: z.string().min(1),
});
