import { asClass, asValue, AwilixContainer } from 'awilix';
import { sessionConfig } from '@config/session/session.config';

import { SessionService } from './session.service';
import { DeviceService } from './device.service';
import { SessionMetrics } from '../../metrics';

export { SessionService, type CreateSessionInput } from './session.service';
export { DeviceService } from './device.service';
export { SessionMetrics, type SessionMetricFields } from '../../metrics';

export function registerSessionServices(container: AwilixContainer): void {
  container.register({
    sessionConfig: asValue(sessionConfig),
    sessionMetrics: asClass(SessionMetrics).singleton(),
    sessionService: asClass(SessionService).singleton(),
    deviceService: asClass(DeviceService).singleton(),
  });
}
