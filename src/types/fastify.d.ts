import 'fastify';
import type { preHandlerHookHandler } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Opt a route out of the deny-by-default auth gate (auth doc 02 §6). */
    public?: boolean;
  }

  interface FastifyRequest {
    /** High-res request start, set by the on-request hook. Absent when a request
     *  is rejected earlier in the onRequest phase (e.g. the deny-by-default gate). */
    startTime?: bigint;
    /** Authentication context, populated by the `authenticate` hook. */
    auth: {
      userId: string;
      sid: string;
      roles: string[];
    } | null;
  }

  interface FastifyInstance {
    /** Deny-by-default authentication preHandler (JWT → epoch → sid denylist). */
    authenticate: preHandlerHookHandler;
    /** Factory producing a role/operability authorization preHandler. */
    authorize: (options?: {
      roles?: string[];
      requireOperableDriver?: boolean;
    }) => preHandlerHookHandler;
  }
}
