import pino from 'pino';
import { config } from '@config';
import { transport } from './transport.js';
import { REDACT_PATHS } from './redact.js';
import { serializers } from './serializers.js';

export const logger = pino({
  level: config.app.environment === 'development' ? 'debug' : 'info',
  ...(transport ? { transport } : {}),
  serializers,
  redact: REDACT_PATHS,
  base: {
    app: config.app.name,
    environment: config.app.environment,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
