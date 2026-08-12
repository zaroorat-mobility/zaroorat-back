import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { RideError } from '../errors/index.js';

export function handleRideError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (isCodedError(err) && err.statusCode < 500) {
    reply.status(err.statusCode).send(
      errorEnvelope(err.code, err.message, request.id, {
        ...(err.details !== undefined ? { details: err.details } : {}),
      }),
    );
    return;
  }

  request.log.error({ err }, '[rides] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected rides error occurred', request.id));
}

export { RideError };
