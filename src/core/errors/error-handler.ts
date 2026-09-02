import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
interface ErrorEnvelope {
  error: {
    code: string;
    messageKey: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
function envelope(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    error: {
      code,
      messageKey: `error.${code.toLowerCase()}`,
      message,
      requestId,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
function codeFor(error: FastifyError, statusCode: number): string {
  if (error.validation) return 'VALIDATION';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 401) return 'UNAUTHENTICATED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode >= 500) return 'INTERNAL';
  return (error.code as string | undefined) ?? 'BAD_REQUEST';
}
/// Socket-level and Prisma connection failures, which arrive with no
/// `statusCode` and so were answered `500 INTERNAL`.
///
/// 500 tells a client the request itself was at fault and must not be retried;
/// a datastore that is down is a transient dependency failure and should say so,
/// the way the Redis path already returns 503. Prisma: P1001 unreachable,
/// P1002 timed out, P1008 operation timeout, P1017 server closed the connection.
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

/// Prisma wraps the driver error, so the whole cause chain is checked rather
/// than the top frame alone. Bounded to keep a self-referential cause from looping.
function isDatastoreUnavailable(error: unknown): boolean {
  for (let current = error, depth = 0; current != null && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error.validation) {
    return reply
      .status(400)
      .send(envelope('VALIDATION', 'Validation failed', request.id, error.validation));
  }
  const statusCode = error.statusCode ?? 500;
  if (statusCode < 500) {
    return reply
      .status(statusCode)
      .send(envelope(codeFor(error, statusCode), error.message, request.id));
  }
  if (isDatastoreUnavailable(error)) {
    request.log.error({ err: error }, 'Datastore unavailable');
    return reply
      .status(503)
      .send(envelope('SERVICE_UNAVAILABLE', 'Service temporarily unavailable', request.id));
  }
  request.log.error({ err: error }, 'Unhandled server error');
  return reply.status(500).send(envelope('INTERNAL', 'Internal Server Error', request.id));
}
