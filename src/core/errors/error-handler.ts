import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error.validation) {
    return reply.status(400).send({
      success: false,
      message: 'Validation failed',
      errors: error.validation,
    });
  }

  // Only 4xx messages are safe to echo back. A 5xx that happens to carry a
  // statusCode is still an internal fault, and its message can contain a
  // connection string, query text, or file path — log it, do not return it.
  if (error.statusCode && error.statusCode < 500) {
    return reply.status(error.statusCode).send({
      success: false,
      message: error.message,
    });
  }

  request.log.error({ err: error }, 'Unhandled server error');

  return reply.status(500).send({
    success: false,
    message: 'Internal Server Error',
  });
}
