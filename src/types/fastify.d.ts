import 'fastify';
import type { preHandlerHookHandler } from 'fastify';
declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }
  interface FastifyRequest {
    startTime?: bigint;
    auth: {
      userId: string;
      sid: string;
      roles: string[];
    } | null;
  }
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
    authorize: (options?: {
      roles?: string[];
      permissions?: string[];
      requireOperableDriver?: boolean;
      requireUntamperedDevice?: boolean;
    }) => preHandlerHookHandler;
  }
}
