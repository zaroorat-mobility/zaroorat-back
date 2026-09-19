import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { IdempotencyInFlightError } from '@core/cache';
export function handleSubscriptionError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // The same Idempotency-Key while the first purchase is still running. It has
  // a `code` but no `statusCode`, so without this it would surface as a 500.
  if (err instanceof IdempotencyInFlightError) {
    reply.status(409).send(errorEnvelope(err.code, err.message, request.id));
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
  request.log.error({ err }, '[subscriptions] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected subscriptions error occurred', request.id));
}
