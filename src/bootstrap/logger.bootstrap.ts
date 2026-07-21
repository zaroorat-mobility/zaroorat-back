import { config } from '@config';

export async function bootstrapLogger() {
  const isDev = config.app.environment === 'local';
  
  // Return the configuration object for Fastify's logger
  // Fastify automatically creates a Pino instance with this config
  return {
    level: isDev ? 'debug' : 'info',
    // We can enable transport like pino-pretty for local dev later if needed
  };
}
