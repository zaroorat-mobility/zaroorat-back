import type { FastifyReply, FastifyRequest } from 'fastify';
export const serializers = {
  req(request: FastifyRequest) {
    return {
      id: request.id,
      method: request.method,
      url: request.url,
      ip: request.ip,
    };
  },
  res(reply: FastifyReply) {
    return {
      statusCode: reply.statusCode,
    };
  },
  err(error: Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  },
};
