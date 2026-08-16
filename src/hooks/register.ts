import { FastifyInstance } from 'fastify';
import onErrorHook from './on-error/on-error.hook.js';
import onRequestHook from './on-request/on-request.hook.js';
import onResponseHook from './on-response/on-response.hook.js';
import preHandlerHook from './pre-handler/pre-handler.hook.js';
export async function registerHooks(app: FastifyInstance): Promise<void> {
  await app.register(onRequestHook);
  await app.register(preHandlerHook);
  await app.register(onResponseHook);
  await app.register(onErrorHook);
}
