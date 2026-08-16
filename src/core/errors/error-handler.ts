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
  request.log.error({ err: error }, 'Unhandled server error');
  return reply.status(500).send(envelope('INTERNAL', 'Internal Server Error', request.id));
}
