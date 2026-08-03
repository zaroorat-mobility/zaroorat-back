import { z } from 'zod';

import { filePurposePolicy } from '@config/file/file.config.js';

/** The purpose names, taken from config so a new purpose cannot be forgotten here. */
const PURPOSES = Object.keys(filePurposePolicy) as [string, ...string[]];

/**
 * `POST /files` body (files doc 02 §2.1).
 *
 * `.strict()` rejects an unknown key rather than dropping it — a client that
 * believed it set something must learn that it did not, the same rule USER's
 * profile patch follows.
 *
 * Note what is **not** validated here: the content-type against the purpose's
 * allow-list, and the size against its ceiling. Both are policy that lives in
 * config (R-FILE-3) and both produce their own catalogued error codes
 * (`UNSUPPORTED_MEDIA_TYPE`, `FILE_TOO_LARGE`), so folding them into a schema
 * would collapse three distinct client remedies into one `VALIDATION`.
 */
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

/** Path parameter for every `/files/{id}` route. */
export const fileIdSchema = z.object({ id: z.string().uuid() });

export type FileIdParams = z.infer<typeof fileIdSchema>;

/**
 * `GET /files/{id}/url` query (files doc 02 §2.3).
 *
 * `disposition` only decides how a browser renders the object; it changes no
 * authorization and is safe to default.
 */
export const readUrlQuerySchema = z
  .object({
    disposition: z.enum(['inline', 'attachment']).default('inline'),
  })
  .strict();

export type ReadUrlQuery = z.infer<typeof readUrlQuerySchema>;
