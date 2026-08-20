import fp from 'fastify-plugin';
import { registerUserRoutes } from '../routes/user.routes';
export const userPlugin = fp(
  async (app) => {
    await registerUserRoutes(app);
  },
  {
    name: 'user-plugin',
  },
);
