import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { RedisService } from '@core/cache';
import { container } from '@core/di';

export interface RateLimitOptions {
  scope: string;
  limit: number;
  windowSeconds: number;
  keyBy?: 'ip' | 'user' | 'both';
  onStoreError?: 'closed' | 'open';
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit: (
      options: RateLimitOptions,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function errorBody(
  code: string,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    error: {
      code,
      messageKey: `error.${code.toLowerCase()}`,
      message,
      requestId,
      ...extra,
    },
  };
}

async function send429(
  request: FastifyRequest,
  reply: FastifyReply,
  retryAfterSeconds: number,
): Promise<void> {
  await reply
    .header('Retry-After', String(retryAfterSeconds))
    .status(429)
    .send(
      errorBody('RATE_LIMITED', 'Too many requests', request.id, {
        retryAfterSec: retryAfterSeconds,
      }),
    );
}

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const redisService = container.resolve<RedisService>('redisService');

  app.decorate('rateLimit', function rateLimit(options: RateLimitOptions) {
    const keyBy = options.keyBy ?? 'ip';
    const onStoreError = options.onStoreError ?? 'closed';

    return async function rateLimitHandler(request: FastifyRequest, reply: FastifyReply) {
      const identifiers: string[] = [];
      if (keyBy === 'ip' || keyBy === 'both') identifiers.push(`ip:${request.ip}`);
      if (keyBy === 'user' || keyBy === 'both') {
        const userId = request.auth?.userId;

        identifiers.push(userId ? `user:${userId}` : `ip:${request.ip}`);
      }

      for (const identifier of identifiers) {
        let result;
        try {
          result = await redisService.rateLimit.hit(
            options.scope,
            identifier,
            options.limit,
            options.windowSeconds,
          );
        } catch (err) {
          request.log.error({ err, scope: options.scope }, '[rate-limit] store unavailable');
          if (onStoreError === 'open') return;
          await reply
            .status(503)
            .send(
              errorBody(
                'SERVICE_UNAVAILABLE',
                'Rate limiting is temporarily unavailable',
                request.id,
              ),
            );
          return;
        }

        if (!result.allowed) {
          request.log.warn(
            { scope: options.scope, identifier, limit: options.limit },
            '[rate-limit] request rejected',
          );
          await send429(request, reply, result.retryAfterSeconds);
          return;
        }
      }
    };
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });
