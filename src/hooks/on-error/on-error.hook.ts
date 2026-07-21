import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

async function onErrorHook(app: FastifyInstance) {
  app.addHook(
    "onError",
    async (request, _reply, error) => {
      request.log.error(
        {
          error,
        },
        "Unhandled request error",
      );
    },
  );
}

export default fp(onErrorHook, {
  name: "on-error-hook",
});
