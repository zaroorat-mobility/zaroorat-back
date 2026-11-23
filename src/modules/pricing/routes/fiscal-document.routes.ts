import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { container } from '@core/di';
import { callerId } from '@core/auth';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import {
  FISCAL_DOCUMENT_TYPES,
  FiscalDocumentService,
  type FiscalDocumentType,
} from '../services/fiscal-document.service.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const downloadQuerySchema = z.object({ token: z.string().min(16).max(1024) });
const listMyQuerySchema = z.object({
  documentType: z.enum(FISCAL_DOCUMENT_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

function handleFiscalError(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ZodError) {
    reply
      .status(400)
      .send(
        errorEnvelope('VALIDATION', 'Request validation failed', req.id, { details: err.issues }),
      );
    return;
  }
  if (isCodedError(err) && (err.statusCode < 500 || err.statusCode === 503)) {
    reply.status(err.statusCode).send(errorEnvelope(err.code, err.message, req.id));
    return;
  }
  req.log.error({ err }, '[fiscal-documents] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'Failed to process fiscal document request', req.id));
}

/// Public signed PDF download route (`/api/v1/fiscal-documents/:id/download?token=...`).
/// Authenticated cryptographically via short-lived HMAC-SHA256 download token bound to documentId.
export async function fiscalDocumentDownloadRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handleFiscalError);
  const service = container.resolve<FiscalDocumentService>('fiscalDocumentService');

  /// Authenticated list of the caller's own issued fiscal documents & wallet recharge receipts.
  fastify.get('/my', async (req, reply) => {
    const query = listMyQuerySchema.parse(req.query ?? {});
    const userId = callerId(req);
    const data = await service.listForUser(userId, {
      ...(query.documentType ? { documentType: query.documentType as FiscalDocumentType } : {}),
      limit: query.limit,
    });
    reply.send({ data });
  });

  fastify.get('/:id/download', { config: { public: true } }, async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const { token } = downloadQuerySchema.parse(req.query);
    service.verifySignedDownloadToken(id, token);
    const { buffer, fileName } = await service.renderPdfBuffer(id);
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(buffer);
  });
}

/// Authenticated participant route (`/api/v1/rides/:id/fiscal-documents`).
/// Returns only the requesting rider's or driver's issued fiscal documents with short-lived signed download paths.
export async function rideFiscalDocumentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handleFiscalError);
  const service = container.resolve<FiscalDocumentService>('fiscalDocumentService');

  fastify.get('/:id/fiscal-documents', async (req, reply) => {
    const { id } = idParamSchema.parse(req.params);
    const userId = callerId(req);
    const data = await service.listForRideParticipant(id, userId);
    reply.send({ data });
  });
}
