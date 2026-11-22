import pino from 'pino';
import { config } from '@config';
import { isLocal } from '@config/env/environment.js';
import { transport } from './transport.js';
import { REDACT_PATHS } from './redact.js';
import { serializers } from './serializers.js';
export const logger = pino({
  level: isLocal(config.app.environment) ? 'debug' : 'info',
  ...(transport ? { transport } : {}),
  serializers,
  redact: isLocal(config.app.environment)
    ? REDACT_PATHS.filter(
        (p) => !p.includes('otp') && !p.includes('phone') && !p.includes('mobiles'),
      )
    : REDACT_PATHS,
  base: {
    app: config.app.name,
    environment: config.app.environment,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
