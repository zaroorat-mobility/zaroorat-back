import type { FastifyReply, FastifyRequest } from 'fastify';
import { AUTH_ERROR_STATUS } from '@modules/auth/http';
import { FileError, FileInUseError, type FileErrorDetail } from '../errors/file.errors.js';
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
export function fileErrorStatus(code: string): number {
  return FILE_ERROR_STATUS[code] ?? 500;
}
export interface FileErrorExtra {
  retryAfterSeconds?: number;
  details?: FileErrorDetail[];
  module?: string;
}
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
