import { Server as SocketServer, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { realtimeConfig } from '@config';
import { isCodedError } from '@core/errors/envelope.js';
import { logger } from '@shared/logger/index.js';
import { createAdapter } from '@socket.io/redis-adapter';
import { createRedisClient } from '@core/cache/client.js';
import {
  CLIENT_COMMAND,
  SOCKET_EVENT,
  room,
  socketEnvelope,
  type SocketEnvelope,
} from './events.js';
import { RealtimeError, SocketUnauthenticatedError } from './realtime.errors.js';
import { SocketAuthService, type SocketPrincipal } from './socket-auth.service.js';
import { RoomAuthorizationService } from './room-authorization.service.js';
import { LocationStreamService } from './location-stream.service.js';
import { RideChatService } from '@modules/rides/services/chat/ride-chat.service.js';
import { uuidV7 } from '@shared/crypto';
import { z } from 'zod';

/// The principal is stashed on the socket by the handshake middleware and read
/// back by every handler. It is never re-derived from client input. It lives on
/// `data` because that is what `fetchSockets()` exposes, on every instance.
interface AuthedSocket extends Socket {
  data: { principal?: SocketPrincipal };
}

function ack(callback: unknown, response: Record<string, unknown>): void {
  if (typeof callback === 'function') (callback as (r: unknown) => void)(response);
}

const chatSendSchema = z.object({
  rideId: z.string().uuid(),
  content: z.string().trim().min(1).max(2000),
});

const chatTypingSchema = z.object({
  rideId: z.string().uuid(),
  isTyping: z.boolean().default(true),
});

/// Owns the Socket.IO server: its lifecycle, its authentication middleware, its
/// room bookkeeping, and the one API the rest of the platform uses to reach a
/// client (`emitToRoom`). Nothing outside this class touches `io`.
export class RealtimeGateway {
  private io: SocketServer | null = null;
  private adapterClients: ReturnType<typeof createRedisClient>[] = [];

  constructor(
    private readonly socketAuthService: SocketAuthService,
    private readonly roomAuthorizationService: RoomAuthorizationService,
    private readonly locationStreamService: LocationStreamService,
    private readonly rideChatService: RideChatService,
  ) {}

  get isRunning(): boolean {
    return this.io !== null;
  }

  get connectionCount(): number {
    return this.io?.engine?.clientsCount ?? 0;
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
    this.io = new SocketServer(httpServer, {
      path: realtimeConfig.path,
      cors: { origin: realtimeConfig.corsOrigins, credentials: true },
      pingInterval: realtimeConfig.pingIntervalMs,
      pingTimeout: realtimeConfig.pingTimeoutMs,
      maxHttpBufferSize: realtimeConfig.maxPayloadBytes,
    });

    this.attachAdapter(this.io);

    this.io.use((socket: AuthedSocket, next) => {
      this.socketAuthService
        .authenticate(socket.handshake)
        .then((principal) => {
          socket.data.principal = principal;
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
  private attachAdapter(io: SocketServer): void {
    if (realtimeConfig.adapter !== 'redis') return;
    // Two dedicated connections, not the shared application client: the pub/sub
    // protocol puts a connection into subscriber mode, where it may issue nothing
    // but (un)subscribe commands. Reusing `redis` here would break every ordinary
    // command the rest of the process makes on it.
    const pubClient = createRedisClient();
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    this.adapterClients = [pubClient, subClient];
    logger.info('[realtime] redis adapter attached; rooms are shared across instances');
  }

  private async onConnection(socket: AuthedSocket): Promise<void> {
    const principal = socket.data.principal;
    if (!principal) {
      socket.disconnect(true);
      return;
    }
    // Identity rooms are joined by the server from ids it resolved itself. The
    // client is told which rooms it got; it does not get to ask for them. The
    // session room is not reported: it exists only so revoking the session can
    // reach this socket.
    const identityRooms = this.roomAuthorizationService.identityRooms(principal);
    await socket.join([...identityRooms, room.session(principal.sid)]);

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

    // Every command is re-authorised before it runs (see `reauthorize`).
    const command = (
      event: string,
      handler: (payload: unknown, callback: unknown) => Promise<void>,
    ): void => {
      socket.on(event, (payload: unknown, callback: unknown) => {
        void this.reauthorize(socket, principal, callback).then((ok) =>
          ok ? handler(payload, callback) : undefined,
        );
      });
    };
    command(CLIENT_COMMAND.JOIN_RIDE, (p, cb) => this.onJoinRide(socket, principal, p, cb));
    command(CLIENT_COMMAND.LEAVE_RIDE, (p, cb) => this.onLeaveRide(socket, p, cb));
    command(CLIENT_COMMAND.LOCATION_UPDATE, (p, cb) =>
      this.onLocationUpdate(socket, principal, p, cb),
    );
    command(CLIENT_COMMAND.CHAT_MESSAGE_SEND, (p, cb) => this.onChatSend(socket, principal, p, cb));
    command(CLIENT_COMMAND.CHAT_TYPING, (p, cb) => this.onChatTyping(socket, principal, p, cb));
    command(CLIENT_COMMAND.DASHBOARD_SUBSCRIBE, (_p, cb) =>
      this.onDashboardSubscribe(socket, principal, cb),
    );
    command(CLIENT_COMMAND.DASHBOARD_UNSUBSCRIBE, (_p, cb) =>
      this.onDashboardUnsubscribe(socket, cb),
    );
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
        if (accepted.etaEnvelope) {
          socket.to(rideRoom).emit(SOCKET_EVENT.ETA_UPDATED, accepted.etaEnvelope);
        }
      }
      ack(callback, {
        ok: true,
        persisted: accepted.persisted,
        rooms: rideRooms.length,
        fixId: accepted.envelope.data.fixId ?? null,
      });
    } catch (err) {
      this.failFrom(socket, callback, err);
    }
  }

  private async onChatSend(
    socket: AuthedSocket,
    principal: SocketPrincipal,
    payload: unknown,
    callback: unknown,
  ): Promise<void> {
    const parsed = chatSendSchema.safeParse(payload);
    if (!parsed.success) {
      return this.fail(
        socket,
        callback,
        'INVALID_SOCKET_PAYLOAD',
        'rideId and content are required',
      );
    }
    try {
      await this.roomAuthorizationService.assertCanJoinRide(principal, parsed.data.rideId);
      const message = await this.rideChatService.sendMessage(
        parsed.data.rideId,
        principal.userId,
        parsed.data.content,
      );
      this.emitToRoom(
        room.ride(parsed.data.rideId),
        socketEnvelope(uuidV7(), SOCKET_EVENT.CHAT_MESSAGE_NEW, {
          rideId: parsed.data.rideId,
          conversationId: message.conversationId,
          messageId: message.id,
          senderId: message.senderId,
          content: message.content,
          messageType: message.messageType,
          createdAt: message.createdAt,
        }),
      );
      ack(callback, { ok: true, message });
    } catch (err) {
      this.failFrom(socket, callback, err);
    }
  }

  private async onChatTyping(
    socket: AuthedSocket,
    principal: SocketPrincipal,
    payload: unknown,
    callback: unknown,
  ): Promise<void> {
    const parsed = chatTypingSchema.safeParse(payload);
    if (!parsed.success) {
      return this.fail(socket, callback, 'INVALID_SOCKET_PAYLOAD', 'rideId is required');
    }
    try {
      await this.roomAuthorizationService.assertCanJoinRide(principal, parsed.data.rideId);
      socket.to(room.ride(parsed.data.rideId)).emit(CLIENT_COMMAND.CHAT_TYPING, {
        rideId: parsed.data.rideId,
        userId: principal.userId,
        isTyping: parsed.data.isTyping,
      });
      ack(callback, { ok: true });
    } catch (err) {
      this.failFrom(socket, callback, err);
    }
  }

  /// Dashboard rooms are re-derived from the database on every subscribe, and
  /// again for every member when a role's permissions change
  /// (`reauthorizeDashboardRooms`). The rooms carry hints only; the data itself
  /// is still read through the permission-checked REST API.
  private async onDashboardSubscribe(
    socket: AuthedSocket,
    principal: SocketPrincipal,
    callback: unknown,
  ): Promise<void> {
    // Replace, never add: membership from an earlier subscribe must not
    // survive a permission that has since been revoked.
    await this.leaveDashboardRooms(socket);
    try {
      const rooms = await this.roomAuthorizationService.dashboardRooms(principal);
      await socket.join(rooms);
      ack(callback, { ok: true, rooms });
    } catch (err) {
      this.failFrom(socket, callback, err);
    }
  }

  private async onDashboardUnsubscribe(socket: AuthedSocket, callback: unknown): Promise<void> {
    await this.leaveDashboardRooms(socket);
    ack(callback, { ok: true });
  }

  private async leaveDashboardRooms(socket: AuthedSocket): Promise<void> {
    await socket.leave(room.opsDashboard());
    await socket.leave(room.financeDashboard());
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

  /// Runs before every command. A principal that is no longer true — session
  /// revoked, token epoch retired, driver no longer operable — ends the socket,
  /// and a reconnect authenticates from scratch. A store that cannot answer
  /// refuses the command but keeps the socket, as HTTP answers 503 rather than
  /// logging out: nothing privileged runs, and an outage is not a mass disconnect.
  private async reauthorize(
    socket: AuthedSocket,
    principal: SocketPrincipal,
    callback: unknown,
  ): Promise<boolean> {
    try {
      await this.socketAuthService.revalidate(principal);
      return true;
    } catch (err) {
      this.failFrom(socket, callback, err);
      if (err instanceof SocketUnauthenticatedError) socket.disconnect(true);
      return false;
    }
  }

  /// A bad command is answered and logged; it never tears the socket down. Only
  /// a failed handshake, or a failed re-authorisation, ends a connection.
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

  /// Server-initiated disconnect of every socket in the rooms, on every instance
  /// (the Redis adapter relays it). For when what authenticated those sockets has
  /// been revoked; a client that reconnects is authenticated from scratch.
  disconnectRooms(roomNames: string | string[]): void {
    this.io?.in(roomNames).disconnectSockets(true);
  }

  /// A role's permissions changed. Tokens carry no permissions, so the sockets
  /// stay authenticated; the only socket privilege permissions grant is dashboard
  /// room membership, decided at subscribe time. Each member's rooms are decided
  /// again now, as a re-subscribe would, and every room no longer granted is
  /// left. A lookup that fails leaves both (fail closed; a re-subscribe restores).
  async reauthorizeDashboardRooms(): Promise<void> {
    if (!this.io) return;
    const dashboardRooms = [room.opsDashboard(), room.financeDashboard()];
    const members = await this.io.in(dashboardRooms).fetchSockets();
    for (const member of members) {
      const principal = (member.data as AuthedSocket['data']).principal;
      const granted = principal
        ? await this.roomAuthorizationService.dashboardRooms(principal).catch((err: unknown) => {
            if (!(err instanceof RealtimeError)) {
              logger.warn({ err }, '[realtime] dashboard re-authorisation failed; rooms revoked');
            }
            return [];
          })
        : [];
      for (const name of dashboardRooms) {
        if (member.rooms.has(name) && !granted.includes(name)) await member.leave(name);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.io) return;
    const io = this.io;
    this.io = null;
    // Disconnects every client, then closes the underlying engine. The HTTP
    // server itself is Fastify's to close.
    await new Promise<void>((resolve) => io.close(() => resolve()));
    // The adapter's own pub/sub connections are ours to release; `io.close()`
    // does not own them.
    const clients = this.adapterClients;
    this.adapterClients = [];
    await Promise.all(clients.map((client) => client.quit().catch(() => client.disconnect())));
    logger.info('[realtime] socket server closed');
  }
}
