import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import { FastifyInstance } from "fastify";

async function helmetPlugin(app: FastifyInstance) {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
  });
}

export default fp(helmetPlugin, {
  name: "helmet",
});
