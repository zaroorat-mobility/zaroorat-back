import { config } from '@config';
import { isLocal } from '@config/env/environment.js';
// pino-pretty is a devDependency: only a developer machine (source checkout) has it.
export const transport = isLocal(config.app.environment)
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;
