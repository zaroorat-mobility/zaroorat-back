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

  if (error.statusCode) {
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
