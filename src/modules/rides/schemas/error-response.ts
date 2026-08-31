import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { RideError } from '../errors/index.js';
export function handleRideError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  // Ride controllers validate with Zod, and this handler did not recognise a
  // ZodError — so every malformed body on a /rides route (bad coordinates, a
  // non-integer rating, a short OTP) returned 500 INTERNAL instead of 400.
  // Matches `handleDriverError` and `handleVehicleError`, which already do this.
  if (err instanceof ZodError) {
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: err.issues,
      }),
    );
    return;
  }
  if (isCodedError(err) && err.statusCode <= 503) {
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
