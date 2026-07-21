import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    startTime: bigint;
    user?: {
      id: string;
      role: string;
    };
  }
}
