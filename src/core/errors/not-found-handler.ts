import { FastifyReply, FastifyRequest } from 'fastify';

export async function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({
    success: false,
    message: `Route ${request.method} ${request.url} not found`,
  });
}
