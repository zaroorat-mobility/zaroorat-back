import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuthError } from '@modules/auth/errors';
import { replyFromAuthError } from '@modules/auth/http';
import type { FilePurposeName } from '@config/file/file.config.js';
import { FileService } from '../file.service.js';
import { FileError, FileValidationError, type FileErrorDetail } from '../errors.js';
import { StorageError } from '../providers/storage.provider.js';
import { replyFileError, replyFromFileError } from './error-response.js';
import { createUploadSchema, fileIdSchema, readUrlQuerySchema } from './file.schemas.js';

/**
 * How long a client should wait before retrying a storage-backed call.
 *
 * Short: a provider blip is usually seconds, and a longer hint would strand a
 * client that could have succeeded immediately.
 */
const STORAGE_RETRY_AFTER_SECONDS = 5;

/**
 * Translate Zod issues into doc 04 §6 details.
 *
 * Carries the field path and a coarse code, and **never the submitted value** —
 * error bodies reach crash reports and support screenshots (doc 04 §5).
 * @param issues The Zod issues.
 * @returns Field-level details.
 */
function detailsFromZodIssues(issues: z.core.$ZodIssue[]): FileErrorDetail[] {
  return issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    code: issue.code.toUpperCase(),
  }));
}

/**
 * HTTP surface for the upload pair (files doc 02 §2.1–§2.2).
 *
 * Handlers are arrow properties so they can be passed straight to Fastify
 * without losing `this`, matching the auth and user controllers.
 */
export class FileController {
  /** @param fileService The upload orchestration service. */
  constructor(private readonly fileService: FileService) {}

  /**
   * `POST /files` — request a scoped write permission.
   *
   * Requires an `Idempotency-Key`: without one a retried request mints a second
   * permission and orphans an object in storage (R-FILE-8). A missing header is
   * `VALIDATION`, following USER's precedent rather than a dedicated code.
   */
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

  /**
   * `POST /files/{id}/complete` — verify the bytes and publish the file.
   *
   * Naturally idempotent: completing an already-`READY` file returns the same
   * body and emits no second event (doc 02 §2.2), so no key is required.
   */
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

  /**
   * `GET /files/{id}/url` — mint a short-lived signed read URL.
   *
   * A caller the policy denies receives the response an unknown id produces
   * (doc 04 §4), so nothing here distinguishes the two.
   */
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

  /** `GET /files/{id}` — metadata only; mints nothing and audits nothing. */
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

  /**
   * Parse a payload, converting a Zod failure into a {@link FileValidationError}.
   * @param schema The schema to apply.
   * @param payload The raw request part.
   * @returns The parsed value, or the error to render.
   */
  private parse<T extends z.ZodTypeAny>(
    schema: T,
    payload: unknown,
  ): { ok: true; value: z.infer<T> } | { ok: false; error: FileValidationError } {
    const result = schema.safeParse(payload);
    if (result.success) return { ok: true, value: result.data as z.infer<T> };
    return { ok: false, error: new FileValidationError(detailsFromZodIssues(result.error.issues)) };
  }

  /**
   * Render a domain error, or rethrow anything this module does not own.
   *
   * `AuthError` is handled because the gate's failures (and the shared
   * `RateLimitedError`) surface through this module's handlers (doc 04 §2.1).
   */
  private handle(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof FileError) return replyFromFileError(request, reply, err);
    if (err instanceof AuthError) return replyFromAuthError(request, reply, err);
    if (err instanceof StorageError) return this.handleStorageFailure(request, reply, err);
    throw err;
  }

  /**
   * Render a storage-backend failure as `503`, never anything else (doc 04 §6).
   *
   * Fail-closed: a dependency that cannot answer must never be read as
   * permission, and must never surface as a `200` carrying a null URL. Letting
   * it reach Fastify's default handler produced a `500` whose body was the
   * platform envelope in neither shape nor content — and whose message named the
   * failing internal operation, which doc 04 §5 forbids.
   *
   * `retryable` decides the **log level, not the status**: both a timeout and a
   * missing bucket are `503` to the client, but only one of them is somebody's
   * pager (doc 09 §2.5).
   */
  private handleStorageFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    err: StorageError,
  ): FastifyReply {
    const context = { err: err.cause, operation: err.operation, retryable: err.retryable };
    if (err.retryable) {
      request.log.warn(context, '[Files] storage backend unavailable');
    } else {
      // Bad credentials or a missing bucket: not self-healing, and the alert in
      // doc 09 §2.5 keys on this.
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
