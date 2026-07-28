import { asClass, asValue, AwilixContainer } from 'awilix';
import { sessionConfig } from '@config/session/session.config';

import { SessionService } from './session.service';
import { DeviceService } from './device.service';
import { SessionMetrics } from './session.metrics';

export { SessionService, type CreateSessionInput } from './session.service';
export { DeviceService } from './device.service';
export { SessionMetrics, type SessionMetricFields } from './session.metrics';

/**
 * Registers the session module (Phase 7) into the Awilix container.
 *
 * `sessionConfig` is a value registration; CLASSIC injection resolves the rest
 * by name (`sessionRepository`, `refreshTokenRepository`, `redisService`,
 * `epochService`, `deviceRepository`, `sessionService`). Must run after the
 * database, redis, auth-repository, and token-service registrations.
 * @param container The application DI container.
 */
export function registerSessionServices(container: AwilixContainer): void {
  container.register({
    sessionConfig: asValue(sessionConfig),
    sessionMetrics: asClass(SessionMetrics).singleton(),
    sessionService: asClass(SessionService).singleton(),
    deviceService: asClass(DeviceService).singleton(),
  });
}
