import { Server as SocketServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { realtimeConfig } from '@config';
import { isCodedError } from '@core/errors/envelope.js';
import { logger } from '@shared/logger/index.js';
import { CLIENT_COMMAND, SOCKET_EVENT, room, type SocketEnvelope } from './events.js';
import { RealtimeError, SocketUnauthenticatedError } from './realtime.errors.js';
import { SocketAuthService, type SocketPrincipal } from './socket-auth.service.js';
import { RoomAuthorizationService } from './room-authorization.service.js';
import { LocationStreamService } from './location-stream.service.js';

/// The principal is stashed on the socket by the handshake middleware and read
/// back by every handler. It is never re-derived from client input.
interface AuthedSocket extends Socket {
  principal?: SocketPrincipal;
}

function ack(callback: unknown, response: Record<string, unknown>): void {
  if (typeof callback === 'function') (callback as (r: unknown) => void)(response);
}

/// Owns the Socket.IO server: its lifecycle, its authentication middleware, its
/// room bookkeeping, and the one API the rest of the platform uses to reach a
/// client (`emitToRoom`). Nothing outside this class touches `io`.
export class RealtimeGateway {
  private io: SocketServer | null = null;

  constructor(
    private readonly socketAuthService: SocketAuthService,
    private readonly roomAuthorizationService: RoomAuthorizationService,
    private readonly locationStreamService: LocationStreamService,
  ) {}

  get isRunning(): boolean {
    return this.io !== null;
  }

  /// Binds to the HTTP server Fastify already listens on, so sockets and the
  /// REST API share one port, one TLS terminator and one CORS story.
  attach(httpServer: HttpServer): void {
    if (!realtimeConfig.enabled) {
      logger.info('[realtime] disabled by configuration; no socket server started');
      return;
    }
    if (this.io) return;
    // Checked before the server is constructed. Constructing first and throwing
    // afterwards left a socket server bound to the HTTP listener with no
    // connection handler and therefore no authentication — harmless only
    // because `startup()` exits on the throw. Validating first removes the
    // dependency on that.
    this.assertAdapterSupported();

    this.io = new SocketServer(httpServer, {
      path: realtimeConfig.path,
      cors: { origin: realtimeConfig.corsOrigins, credentials: true },
      pingInterval: realtimeConfig.pingIntervalMs,
      pingTimeout: realtimeConfig.pingTimeoutMs,
      maxHttpBufferSize: realtimeConfig.maxPayloadBytes,
    });

    this.io.use((socket: AuthedSocket, next) => {
      this.socketAuthService
        .authenticate(socket.handshake)
        .then((principal) => {
          socket.principal = principal;
          next();
        })
        .catch((err: unknown) => {
          const error =
            err instanceof RealtimeError ? err : new SocketUnauthenticatedError('Unauthorised');
          // socket.io surfaces `message` and `data` to the client's connect_error.
          next(Object.assign(new Error(error.message), { data: { code: error.code } }));
        });
    });
    this.io.on('connection', (socket: AuthedSocket) => void this.onConnection(socket));
    logger.info({ path: realtimeConfig.path, adapter: realtimeConfig.adapter }, '[realtime] ready');
  }

  /// Single-instance deployments need no adapter at all: rooms live in this
  /// process's memory and every emit reaches every member. The moment a second
  /// API instance exists that stops being true — a customer connected to
  /// instance A never sees an emit made on instance B — so `REALTIME_ADAPTER`
  /// exists to make the requirement explicit and to fail loudly rather than
  /// silently dropping half the traffic.
  private assertAdapterSupported(): void {
    if (realtimeConfig.adapter !== 'redis') return;
    throw new Error(
      'REALTIME_ADAPTER=redis requires the @socket.io/redis-adapter package, which is not ' +
        'installed. Install it and wire it here before running more than one API instance; ' +
        'until then rooms are process-local and a multi-instance deployment WILL drop events.',
    );
  }

  private async onConnection(socket: AuthedSocket): Promise<void> {
    const principal = socket.principal;
    if (!principal) {
      socket.disconnect(true);
      return;
    }
    // Identity rooms are joined by the server from ids it resolved itself. The
    // client is told which rooms it got; it does not get to ask for them.
    const identityRooms = this.roomAuthorizationService.identityRooms(principal);
    await socket.join(identityRooms);

    socket.emit(SOCKET_EVENT.READY, {
      userId: principal.userId,
      driverId: principal.driverId,
      roles: principal.roles,
      rooms: identityRooms,
      /// Socket messages are not the source of truth. A client that has just
      /// (re)connected must re-read state from the REST API rather than assume
      /// it can reconstruct it from whatever arrives next.
      resync: { rides: '/api/v1/rides/active', offers: '/api/v1/rides/offers' },
    });

    socket.on(CLIENT_COMMAND.JOIN_RIDE, (payload: unknown, callback: unknown) => {
      void this.onJoinRide(socket, principal, payload, callback);
    });
    socket.on(CLIENT_COMMAND.LEAVE_RIDE, (payload: unknown, callback: unknown) => {
      void this.onLeaveRide(socket, payload, callback);
    });
    socket.on(CLIENT_COMMAND.LOCATION_UPDATE, (payload: unknown, callback: unknown) => {
      void this.onLocationUpdate(socket, principal, payload, callback);
    });
    socket.on('disconnect', () => {
      // socket.io leaves every room for us; the only thing it cannot know about
      // is the per-driver throttle state.
      if (principal.driverId) this.locationStreamService.forget(principal.driverId);
    });
  }

  /// Only a well-formed UUID is accepted. Anything else would reach a `@db.Uuid`
  /// lookup and come back as a database error, which the client would see as a
  /// *different* code than an unauthorised-but-valid id — enough to tell
  /// "this ride does not exist" from "this ride is not yours". Rooms answer both
  /// the same way, and this keeps that true for malformed input too.
  private static readonly UUID =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

  private rideIdOf(payload: unknown): string | null {
    const raw =
      typeof payload === 'string' ? payload : (payload as { rideId?: unknown } | null)?.rideId;
    if (typeof raw !== 'string' || !RealtimeGateway.UUID.test(raw)) return null;
    return raw;
  }

  private async onJoinRide(
    socket: AuthedSocket,
    principal: SocketPrincipal,
    payload: unknown,
    callback: unknown,
  ): Promise<void> {
    const rideId = this.rideIdOf(payload);
    if (!rideId) return this.fail(socket, callback, 'INVALID_SOCKET_PAYLOAD', 'rideId is required');
    try {
      // Re-checked against the ride row every time. A client cannot join a ride
      // room by naming one, however many times it asks.
      const rideRoom = await this.roomAuthorizationService.assertCanJoinRide(principal, rideId);
      await socket.join(rideRoom);
      ack(callback, { ok: true, room: rideRoom });
    } catch (err) {
      this.failFrom(socket, callback, err);
    }
  }

  private async onLeaveRide(
    socket: AuthedSocket,
    payload: unknown,
    callback: unknown,
  ): Promise<void> {
    const rideId = this.rideIdOf(payload);
    if (!rideId) return this.fail(socket, callback, 'INVALID_SOCKET_PAYLOAD', 'rideId is required');
    await socket.leave(room.ride(rideId));
    ack(callback, { ok: true });
  }

  /// A driver's position goes only to the ride rooms this socket has already
  /// been admitted to. That is what confines it to the one customer whose trip
  /// the driver is on: there is no global driver-location channel to subscribe
  /// to, and joining a ride room required passing `assertCanJoinRide` first.
  private async onLocationUpdate(
    socket: AuthedSocket,
    principal: SocketPrincipal,
    payload: unknown,
    callback: unknown,
  ): Promise<void> {
    try {
      const accepted = await this.locationStreamService.accept(principal, payload);
      const rideRooms = [...socket.rooms].filter((name) => name.startsWith('ride:'));
      for (const rideRoom of rideRooms) {
        socket.to(rideRoom).emit(SOCKET_EVENT.DRIVER_LOCATION, accepted.envelope);
      }
      ack(callback, { ok: true, persisted: accepted.persisted, rooms: rideRooms.length });
    } catch (err) {
      this.failFrom(socket, callback, err);
    }
  }

  private failFrom(socket: AuthedSocket, callback: unknown, err: unknown): void {
    if (err instanceof RealtimeError) {
      return this.fail(socket, callback, err.code, err.message);
    }
    // Domain errors reach here too — a location frame runs through
    // `LocationService`, which raises IMPLAUSIBLE_LOCATION or
    // MOCK_LOCATION_REJECTED. Those are the client's fault and carry a code it
    // can act on, so they are relayed rather than flattened into a generic
    // failure, exactly as `handleRideError` relays them over HTTP.
    if (isCodedError(err) && err.statusCode < 500) {
      return this.fail(socket, callback, err.code, err.message);
    }
    logger.error({ err }, '[realtime] unhandled socket handler error');
    this.fail(socket, callback, 'REALTIME_ERROR', 'An unexpected realtime error occurred');
  }

  /// A bad command is answered and logged; it never tears the socket down. Only
  /// a failed handshake refuses a connection.
  private fail(socket: AuthedSocket, callback: unknown, code: string, message: string): void {
    ack(callback, { ok: false, error: { code, message } });
    socket.emit(SOCKET_EVENT.ERROR, { code, message });
  }

  /// The only way anything outside this module reaches a client. Accepts a list
  /// of rooms because socket.io unions them — a client that belongs to two of
  /// the named rooms receives the message once, not twice.
  emitToRoom(roomName: string | string[], envelope: SocketEnvelope): void {
    if (!this.io) return;
    this.io.to(roomName).emit(envelope.type, envelope);
  }

  /// Terminal ride events close the room. Without this a driver stays in the
  /// room of a ride they are no longer on and would keep streaming a position
  /// into it — membership was authorised once, at join time, and this is what
  /// revokes it.
  async closeRideRoom(rideId: string): Promise<void> {
    if (!this.io) return;
    const name = room.ride(rideId);
    const sockets = await this.io.in(name).fetchSockets();
    for (const member of sockets) await member.leave(name);
  }

  async close(): Promise<void> {
    if (!this.io) return;
    const io = this.io;
    this.io = null;
    // Disconnects every client, then closes the underlying engine. The HTTP
    // server itself is Fastify's to close.
    await new Promise<void>((resolve) => io.close(() => resolve()));
    logger.info('[realtime] socket server closed');
  }
}
