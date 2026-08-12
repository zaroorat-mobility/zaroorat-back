import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

import { config } from '@config';

export default fp(
  async function swaggerPlugin(app: FastifyInstance): Promise<void> {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Zaroorat Mobility Backend API',
          description: 'Zaroorat Ride-Hailing Platform API documentation.',
          version: '1.0.0',
        },
        servers: [
          {
            url: `http://localhost:${config.server.port}`,
            description: 'Local Development Server',
          },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'Enter JWT access token obtained from /api/v1/auth/otp/verify',
            },
            idempotencyKey: {
              type: 'apiKey',
              name: 'Idempotency-Key',
              in: 'header',
              description: 'Required header for state-changing endpoints',
            },
          },
        },
        tags: [
          { name: 'System', description: 'Health & readiness check endpoints' },
          { name: 'Auth', description: 'OTP authentication, tokens, session & device security' },
          {
            name: 'Users',
            description: 'User profiles, emergency contacts, saved places, and account management',
          },
          {
            name: 'Files',
            description: 'Presigned upload/download operations and file management',
          },
        ],
      },
    });

    await app.register(fastifySwaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
        persistAuthorization: true,
      },
      staticCSP: true,
      transformSpecificationClone: true,
    });
  },
  { name: 'swagger-plugin' },
);
