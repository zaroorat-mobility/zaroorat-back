import fp from 'fastify-plugin';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { config } from '@config';
const TAG_BY_PREFIX: Record<string, string> = {
  rides: 'Rides',
  drivers: 'Drivers',
  payments: 'Payments',
  vehicles: 'Vehicles',
  'vehicle-types': 'Vehicles',
};
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
          { name: 'Rides', description: 'Ride quotes, requests, lifecycle and receipts' },
          {
            name: 'Drivers',
            description: 'Driver onboarding, status, location and wallet',
          },
          {
            name: 'Vehicles',
            description:
              'Vehicle type catalog, driver vehicle claim/management, documents and verification',
          },
          {
            name: 'Payments',
            description: 'Wallet, payment intents, refunds, payouts and gateway webhooks',
          },
        ],
      },
      transform: ({ schema, url }) => {
        const tag = TAG_BY_PREFIX[url.split('/')[3] ?? ''];
        if (tag == null || schema?.tags != null) return { schema, url };
        return { schema: { ...schema, tags: [tag] }, url };
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
