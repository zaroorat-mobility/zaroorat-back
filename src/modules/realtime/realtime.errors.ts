/// Shaped like every other module's error type (`RideError`, `VehicleError`) so
/// the socket layer reports failures in the same vocabulary the HTTP API does —
/// a stable `code` the client switches on, never a prose string.
export class RealtimeError extends Error {
  readonly code: string;
  constructor(message: string, code = 'REALTIME_ERROR') {
    super(message);
    this.name = 'RealtimeError';
    this.code = code;
  }
}
export class SocketUnauthenticatedError extends RealtimeError {
  constructor(message = 'A valid access token is required to open a socket') {
    super(message, 'SOCKET_UNAUTHENTICATED');
    this.name = 'SocketUnauthenticatedError';
  }
}
export class SocketForbiddenError extends RealtimeError {
  constructor(message: string) {
    super(message, 'SOCKET_FORBIDDEN');
    this.name = 'SocketForbiddenError';
  }
}
export class RoomAccessDeniedError extends RealtimeError {
  constructor(roomName: string) {
    super(`You are not a participant of '${roomName}'`, 'ROOM_ACCESS_DENIED');
    this.name = 'RoomAccessDeniedError';
  }
}
export class InvalidSocketPayloadError extends RealtimeError {
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message, 'INVALID_SOCKET_PAYLOAD');
    this.name = 'InvalidSocketPayloadError';
    this.details = details;
  }
}
export class LocationRateLimitedError extends RealtimeError {
  constructor(retryInMs: number) {
    super(`Location updates are limited; retry in ${retryInMs}ms`, 'LOCATION_RATE_LIMITED');
    this.name = 'LocationRateLimitedError';
  }
}
export class StaleLocationError extends RealtimeError {
  constructor(message = 'This location frame is older than the one already recorded') {
    super(message, 'STALE_LOCATION');
    this.name = 'StaleLocationError';
  }
}
