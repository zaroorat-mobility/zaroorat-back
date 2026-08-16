import fp from 'fastify-plugin';
import { registerFileRoutes } from '../routes/file.routes.js';
export const filePlugin = fp(
  async (app) => {
    await registerFileRoutes(app);
  },
  {
    name: 'file-plugin',
  },
);
