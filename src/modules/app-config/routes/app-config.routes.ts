import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { errorEnvelope } from '@core/errors/envelope.js';
import { AppConfigController } from '../controllers/app-config.controller.js';

function handleAppConfigError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ZodError) {
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: err.issues,
      }),
    );
    return;
  }
  request.log.error({ err }, '[app-config] unhandled error');
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', 'An unexpected app-config error occurred', request.id));
}

export async function appConfigRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<AppConfigController>('appConfigController');
  fastify.setErrorHandler(handleAppConfigError);

  fastify.get(
    '/',
    {
      config: { public: true },
      preHandler: fastify.rateLimit(rateLimits.appConfig),
      schema: {
        tags: ['AppConfig'],
        summary: 'Get public app configuration bundle',
        querystring: {
          type: 'object',
          required: ['app'],
          properties: {
            app: { type: 'string', enum: ['driver', 'rider', 'admin'] },
            locale: { type: 'string', minLength: 2, maxLength: 10, default: 'en' },
            platform: { type: 'string' },
          },
        },
      },
    },
    (req, reply) => controller.getConfig(req, reply),
  );

  fastify.get(
    '/locales/:code',
    {
      config: { public: true },
      preHandler: fastify.rateLimit(rateLimits.appConfig),
      schema: {
        tags: ['AppConfig'],
        summary: 'Get locale strings for an app',
        params: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 2, maxLength: 10 } },
        },
        querystring: {
          type: 'object',
          required: ['app'],
          properties: {
            app: { type: 'string', enum: ['driver', 'rider', 'admin'] },
          },
        },
      },
    },
    (req, reply) => controller.getLocaleStrings(req, reply),
  );
}
