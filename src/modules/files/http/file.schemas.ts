import { z } from 'zod';

import { filePurposePolicy } from '@config/file/file.config.js';

const PURPOSES = Object.keys(filePurposePolicy) as [string, ...string[]];

export const createUploadSchema = z
  .object({
    purpose: z.enum(PURPOSES),
    fileName: z.string().min(1).max(1024),
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    checksumSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest')
      .optional(),
  })
  .strict();

export type CreateUploadBody = z.infer<typeof createUploadSchema>;

export const fileIdSchema = z.object({ id: z.string().uuid() });

export type FileIdParams = z.infer<typeof fileIdSchema>;

export const readUrlQuerySchema = z
  .object({
    disposition: z.enum(['inline', 'attachment']).default('inline'),
  })
  .strict();

export type ReadUrlQuery = z.infer<typeof readUrlQuerySchema>;
