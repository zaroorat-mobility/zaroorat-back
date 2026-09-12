import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
export function handleSubscriptionError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
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
