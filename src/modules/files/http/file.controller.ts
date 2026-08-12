import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuthError } from '@modules/auth/errors';
import { replyFromAuthError } from '@modules/auth/http';
import type { FilePurposeName } from '@config/file/file.config.js';
import { FileService } from '../services/file.service.js';
import { FileError, FileValidationError, type FileErrorDetail } from '../errors/file.errors.js';
import { StorageError } from '../providers/storage.provider.js';
import { replyFileError, replyFromFileError } from './error-response.js';
import { createUploadSchema, fileIdSchema, readUrlQuerySchema } from './file.schemas.js';

const STORAGE_RETRY_AFTER_SECONDS = 5;

function detailsFromZodIssues(issues: z.core.$ZodIssue[]): FileErrorDetail[] {
  return issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    code: issue.code.toUpperCase(),
  }));
}

export class FileController {
  constructor(private readonly fileService: FileService) {}

  createUpload = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyFileError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      return replyFileError(request, reply, 'VALIDATION', 'Idempotency-Key header is required');
    }

    const parsed = this.parse(createUploadSchema, request.body);
    if (!parsed.ok) return this.handle(request, reply, parsed.error);

    try {
      const result = await this.fileService.createUpload({
        ownerUserId: auth.userId,
        purpose: parsed.value.purpose as FilePurposeName,
        fileName: parsed.value.fileName,
        contentType: parsed.value.contentType,
        sizeBytes: parsed.value.sizeBytes,
        ...(parsed.value.checksumSha256 != null
          ? { checksumSha256: parsed.value.checksumSha256 }
          : {}),
        requestId: request.id,
      });
      return reply.status(201).send(result);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  completeUpload = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyFileError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const parsed = this.parse(fileIdSchema, request.params);
    if (!parsed.ok) return this.handle(request, reply, parsed.error);

    try {
      const result = await this.fileService.completeUpload(
        parsed.value.id,
        auth.userId,
        request.id,
      );
      return reply.status(200).send(result);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  getReadUrl = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyFileError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const params = this.parse(fileIdSchema, request.params);
    if (!params.ok) return this.handle(request, reply, params.error);
    const query = this.parse(readUrlQuerySchema, request.query ?? {});
    if (!query.ok) return this.handle(request, reply, query.error);

    try {
      const result = await this.fileService.getReadUrl(
        params.value.id,
        { userId: auth.userId, roles: auth.roles },
        query.value.disposition,
        request.id,
      );
      return reply.status(200).send(result);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  getMetadata = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyFileError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const params = this.parse(fileIdSchema, request.params);
    if (!params.ok) return this.handle(request, reply, params.error);

    try {
      const result = await this.fileService.getMetadata(params.value.id, {
        userId: auth.userId,
        roles: auth.roles,
      });
      return reply.status(200).send(result);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  remove = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyFileError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const params = this.parse(fileIdSchema, request.params);
    if (!params.ok) return this.handle(request, reply, params.error);

    try {
      await this.fileService.remove(params.value.id, auth.userId, request.id);
      return reply.status(204).send();
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  private parse<T extends z.ZodTypeAny>(
    schema: T,
    payload: unknown,
  ): { ok: true; value: z.infer<T> } | { ok: false; error: FileValidationError } {
    const result = schema.safeParse(payload);
    if (result.success) return { ok: true, value: result.data as z.infer<T> };
    return { ok: false, error: new FileValidationError(detailsFromZodIssues(result.error.issues)) };
  }

  private handle(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof FileError) return replyFromFileError(request, reply, err);
    if (err instanceof AuthError) return replyFromAuthError(request, reply, err);
    if (err instanceof StorageError) return this.handleStorageFailure(request, reply, err);
    throw err;
  }

  private handleStorageFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    err: StorageError,
  ): FastifyReply {
    const context = { err: err.cause, operation: err.operation, retryable: err.retryable };
    if (err.retryable) {
      request.log.warn(context, '[Files] storage backend unavailable');
    } else {
      request.log.error(context, '[Files] storage backend misconfigured');
    }

    return replyFileError(
      request,
      reply,
      'SERVICE_UNAVAILABLE',
      'File storage is temporarily unavailable',
      { retryAfterSeconds: STORAGE_RETRY_AFTER_SECONDS },
    );
  }
}
