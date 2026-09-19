import type { FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { IdempotencyInFlightError } from '@core/cache';
import { PaymentError } from '../errors/index.js';
export function handlePaymentError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // A second request with the same Idempotency-Key while the first is still
  // running. Refusing it is correct — nothing is written — and the caller
  // should retry; auth, users and admin payment routes already answer 409.
  // It carries a `code` but no `statusCode`, so it used to fall through to 500.
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
  request.log.error({ err }, '[payments] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected payments error occurred', request.id));
}
export { PaymentError };
