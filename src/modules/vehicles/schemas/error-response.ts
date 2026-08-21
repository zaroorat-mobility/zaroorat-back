import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { VehicleError } from '../errors/index.js';
export function handleVehicleError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof ZodError) {
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: err.issues,
      }),
    );
    return;
  }
  if (isCodedError(err) && err.statusCode < 500) {
    reply.status(err.statusCode).send(errorEnvelope(err.code, err.message, request.id));
    return;
  }
  request.log.error({ err }, '[vehicles] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected vehicles error occurred', request.id));
}
export { VehicleError };
