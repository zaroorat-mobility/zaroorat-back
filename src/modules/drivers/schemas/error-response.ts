import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { FileError } from '@modules/files';
import { replyFromFileError } from '@modules/files/schemas';
import { DriverError } from '../errors/index.js';
export function handleDriverError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof FileError) {
    replyFromFileError(request, reply, err);
    return;
  }
  if (err instanceof ZodError) {
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: err.issues,
      }),
    );
    return;
  }
  if (isCodedError(err) && err.statusCode < 500) {
    reply.status(err.statusCode).send(
      errorEnvelope(err.code, err.message, request.id, {
        ...(err.details !== undefined ? { details: err.details } : {}),
      }),
    );
    return;
  }
  request.log.error({ err }, '[drivers] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected drivers error occurred', request.id));
}
export { DriverError };
