import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

async function preHandlerHook(app: FastifyInstance) {
  app.addHook("preHandler", async (_request, _reply) => {
    // Reserved for:
    // Authentication
    // Authorization
    // Permission checks
  });
}

export default fp(preHandlerHook, {
  name: "pre-handler-hook",
});
