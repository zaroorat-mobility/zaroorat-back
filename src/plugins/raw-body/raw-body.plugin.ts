import type { FastifyInstance, FastifyRequest } from 'fastify';
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}
export function registerRawJsonParser(scope: FastifyInstance): void {
  scope.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request: FastifyRequest, body: Buffer, done) => {
      request.rawBody = body;
      if (body.length === 0) {
        done(null, null);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        const error = err as Error & {
          statusCode?: number;
        };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );
}
