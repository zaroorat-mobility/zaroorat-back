import Fastify, { FastifyInstance } from 'fastify';

export async function bootstrapApplication(loggerOptions: any): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
  });

  return app;
}
