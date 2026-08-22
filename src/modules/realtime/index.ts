import { asClass, AwilixContainer } from 'awilix';
import { RealtimeGateway } from './realtime.gateway.js';
import { SocketAuthService } from './socket-auth.service.js';
import { RoomAuthorizationService } from './room-authorization.service.js';
import { LocationStreamService } from './location-stream.service.js';
export * from './events.js';
export * from './realtime.errors.js';
export { RealtimeGateway } from './realtime.gateway.js';
export { SocketAuthService, type SocketPrincipal } from './socket-auth.service.js';
export { RoomAuthorizationService } from './room-authorization.service.js';
export { LocationStreamService, locationFrameSchema } from './location-stream.service.js';
export function registerRealtimeModule(container: AwilixContainer): void {
  container.register({
    socketAuthService: asClass(SocketAuthService).singleton(),
    roomAuthorizationService: asClass(RoomAuthorizationService).singleton(),
    locationStreamService: asClass(LocationStreamService).singleton(),
    realtimeGateway: asClass(RealtimeGateway).singleton(),
  });
}
