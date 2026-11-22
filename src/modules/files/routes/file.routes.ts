import type { FastifyInstance } from 'fastify';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { FileService } from '../services/file.service.js';
import { FileController } from '../controllers/file.controller.js';
import {
  createUploadBodySchema,
  createUploadResponse,
  fileErrorResponseSchema as err,
  fileIdParamSchema,
  fileMetadataResponse,
  idempotencyHeaderSchema,
  noContentResponse,
  readUrlQuerySchema,
  readUrlResponse,
} from '../schemas/file.responses.js';
const commonErrors = { 400: err, 401: err, 403: err, 500: err, 503: err } as const;
const itemErrors = { ...commonErrors, 404: err } as const;
export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  const controller = new FileController(container.resolve<FileService>('fileService'));
  app.post(
    '/',
    {
      preHandler: app.rateLimit(rateLimits.fileUpload),
      schema: {
        tags: ['Files'],
        summary: 'Initialize file upload',
        description:
          'Reserves a file record and returns a presigned S3 PUT. The object is not usable ' +
          'until POST /files/{id}/complete verifies it.',
        security: [{ bearerAuth: [] }],
        headers: idempotencyHeaderSchema,
        body: createUploadBodySchema,
        response: {
          201: createUploadResponse,
          ...commonErrors,
          413: err,
          415: err,
          429: err,
        },
      },
    },
    controller.createUpload,
  );
  app.post(
    '/:id/complete',
    {
      schema: {
        tags: ['Files'],
        summary: 'Complete file upload',
        description:
          'Verifies the stored object \u2014 magic bytes against the declared content type, actual ' +
          'size and dimensions against the purpose policy, checksum if one was declared, and ' +
          'EXIF location where the purpose forbids it \u2014 then commits the file as READY. A ' +
          'refused object is deleted from storage. Repeating the call on a READY file returns ' +
          'the same result.',
        security: [{ bearerAuth: [] }],
        params: fileIdParamSchema,
        response: {
          200: fileMetadataResponse,
          ...itemErrors,
          409: err,
          410: err,
          413: err,
          422: err,
        },
      },
    },
    controller.completeUpload,
  );
  app.get(
    '/:id',
    {
      schema: {
        tags: ['Files'],
        summary: 'Get file metadata',
        description: 'Owner, or an operator holding the purpose\u2019s read scope. Others get 404.',
        security: [{ bearerAuth: [] }],
        params: fileIdParamSchema,
        response: { 200: fileMetadataResponse, ...itemErrors },
      },
    },
    controller.getMetadata,
  );
  app.get(
    '/:id/url',
    {
      schema: {
        tags: ['Files'],
        summary: 'Get presigned read URL',
        description:
          'Time-limited presigned URL for a private object. Owner, or an operator holding the ' +
          'purpose\u2019s read scope \u2014 operator reads are audited. Rate limited per user.',
        security: [{ bearerAuth: [] }],
        params: fileIdParamSchema,
        querystring: readUrlQuerySchema,
        response: { 200: readUrlResponse, ...itemErrors, 429: err },
      },
    },
    controller.getReadUrl,
  );
  app.delete(
    '/:id',
    {
      schema: {
        tags: ['Files'],
        summary: 'Soft-delete file',
        description:
          'Marks the file DELETED and hands it to the retention job. Refused with 409 ' +
          'FILE_IN_USE while another module still references it. Idempotent on an already ' +
          'deleted file.',
        security: [{ bearerAuth: [] }],
        params: fileIdParamSchema,
        response: { 204: noContentResponse, ...itemErrors, 409: err },
      },
    },
    controller.remove,
  );
}
