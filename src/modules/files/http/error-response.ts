import type { FastifyReply, FastifyRequest } from 'fastify';

import { AUTH_ERROR_STATUS } from '@modules/auth/http';
import { FileError, FileInUseError, type FileErrorDetail } from '../errors.js';

/**
 * HTTP status for each error code reachable from this module (files doc 04 §2).
 *
 * Extends `AUTH_ERROR_STATUS` with the FILES-only codes rather than restating
 * the shared ones, exactly as `USER_ERROR_STATUS` does — so a code's status is
 * defined once and the three modules can never disagree.
 *
 * `FORBIDDEN` is deliberately absent from the FILES additions: returning it
 * would confirm a file exists (doc 04 §4).
 */
export const FILE_ERROR_STATUS: Record<string, number> = {
  ...AUTH_ERROR_STATUS,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPLOAD_NOT_FOUND: 409,
  FILE_IN_USE: 409,
  UPLOAD_EXPIRED: 410,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  CONTENT_MISMATCH: 422,
  CHECKSUM_MISMATCH: 422,
  EXIF_LOCATION_PRESENT: 422,
};

/** Resolve the HTTP status for an error code (unknown codes are a 500, not a guess). */
export function fileErrorStatus(code: string): number {
  return FILE_ERROR_STATUS[code] ?? 500;
}

/** Extra fields that may accompany a FILES error body. */
export interface FileErrorExtra {
  retryAfterSeconds?: number;
  details?: FileErrorDetail[];
  /** Names the owning module on `FILE_IN_USE`, and nothing more (doc 04 §2.2). */
  module?: string;
}

/** The platform error envelope, `file` namespace (files doc 04 §1). */
export interface FileErrorBody {
  error: {
    code: string;
    messageKey: string;
    message: string;
    requestId: string;
    retryAfterSec?: number;
    details?: FileErrorDetail[];
    module?: string;
  };
}

/**
 * Build the doc 04 §1 error envelope.
 *
 * `messageKey` is derived as `file.<code>`, the same derivation AUTH and USER
 * use in their namespaces.
 * @param code Stable machine code.
 * @param message Human-readable summary.
 * @param requestId Correlation id from the request.
 * @param extra Optional retry hint, field details, or owning module.
 * @returns The envelope body.
 */
export function buildFileErrorBody(
  code: string,
  message: string,
  requestId: string,
  extra?: FileErrorExtra,
): FileErrorBody {
  return {
    error: {
      code,
      messageKey: `file.${code.toLowerCase()}`,
      message,
      requestId,
      ...(extra?.retryAfterSeconds != null ? { retryAfterSec: extra.retryAfterSeconds } : {}),
      ...(extra?.details != null ? { details: extra.details } : {}),
      ...(extra?.module != null ? { module: extra.module } : {}),
    },
  };
}

/**
 * Send a doc 04 error response with the mapped status.
 * @param request The request, for its correlation id.
 * @param reply The reply to send on.
 * @param code Stable machine code.
 * @param message Human-readable summary.
 * @param extra Optional retry hint, field details, or owning module.
 * @returns The reply, sent.
 */
export function replyFileError(
  request: FastifyRequest,
  reply: FastifyReply,
  code: string,
  message: string,
  extra?: FileErrorExtra,
): FastifyReply {
  if (extra?.retryAfterSeconds != null) {
    reply.header('Retry-After', String(extra.retryAfterSeconds));
  }
  return reply
    .status(fileErrorStatus(code))
    .send(buildFileErrorBody(code, message, request.id, extra));
}

/**
 * Send a {@link FileError} using its code, message, and details.
 * @param request The request, for its correlation id.
 * @param reply The reply to send on.
 * @param error The domain error to render.
 * @returns The reply, sent.
 */
export function replyFromFileError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: FileError,
): FastifyReply {
  return replyFileError(request, reply, error.code, error.message, {
    ...(error.details ? { details: error.details } : {}),
    ...(error instanceof FileInUseError ? { module: error.module } : {}),
  });
}
