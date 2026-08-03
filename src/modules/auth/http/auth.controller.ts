import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { UserDevice, UserSession } from '@core/database/types';
import { AuthService, type DeviceContext } from '../auth.service';
import { AuthError } from '../errors';
import { replyAuthError, replyFromAuthError } from './error-response';
import { sendOtpSchema, verifyOtpSchema, refreshSchema, logoutSchema } from './auth.schemas';

/** Map a validated device payload to the service's device context. */
function toDeviceContext(device: z.infer<typeof verifyOtpSchema>['device']): DeviceContext {
  if (!device) return {};
  return {
    ...(device.deviceId != null ? { deviceId: device.deviceId } : {}),
    ...(device.platform != null ? { platform: device.platform } : {}),
    ...(device.fingerprint != null ? { fingerprint: device.fingerprint } : {}),
    ...(device.isRooted != null ? { isRooted: device.isRooted } : {}),
    ...(device.isJailbroken != null ? { isJailbroken: device.isJailbroken } : {}),
    ...(device.fcmToken != null ? { fcmToken: device.fcmToken } : {}),
    ...(device.appVersion != null ? { appVersion: device.appVersion } : {}),
    ...(device.osVersion != null ? { osVersion: device.osVersion } : {}),
  };
}

/** Present a session as a safe self-service DTO. */
function toSessionDto(session: UserSession, currentSid: string) {
  return {
    id: session.id,
    deviceId: session.deviceId,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    loginMethod: session.loginMethod,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    current: session.id === currentSid,
  };
}

/**
 * Present a device as a safe self-service DTO.
 *
 * `fingerprint` is deliberately absent. It is a risk signal AUTH matches against,
 * and handing it back to the client turns it into something an attacker can read
 * off one compromised session and replay from another (doc 01 R-DEVICE-5 treats
 * device signals as security data). `isRooted`/`isJailbroken` are included
 * because the user benefits from seeing them and cannot act on them anyway.
 */
function toDeviceDto(device: UserDevice, currentDeviceId: string | null) {
  return {
    id: device.id,
    deviceId: device.deviceId,
    platform: device.platform,
    trustState: device.trustState,
    isRooted: device.isRooted,
    isJailbroken: device.isJailbroken,
    appVersion: device.appVersion,
    osVersion: device.osVersion,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
    current: device.id === currentDeviceId,
  };
}

/**
 * HTTP controllers for the AUTH API (auth doc 04). Each handler only validates
 * the request, calls {@link AuthService}, and shapes the response — no business
 * logic. Domain (`AuthError`) failures are mapped to the doc-05 envelope; any
 * other error propagates to the global handler as a 500.
 */
export class AuthController {
  /** @param authService The auth orchestrator. */
  constructor(private readonly authService: AuthService) {}

  /** `POST /otp/send` — request an OTP (uniform, public). */
  sendOtp = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const parsed = sendOtpSchema.safeParse(request.body);
    if (!parsed.success) {
      return replyAuthError(request, reply, 'VALIDATION', 'Request validation failed', {
        details: parsed.error.issues,
      });
    }
    try {
      const result = await this.authService.sendOtp({
        phoneNumber: parsed.data.phoneNumber,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        ...(parsed.data.device?.deviceId != null ? { deviceId: parsed.data.device.deviceId } : {}),
        ...(parsed.data.device?.fingerprint != null
          ? { deviceFingerprint: parsed.data.device.fingerprint }
          : {}),
      });
      return reply.status(200).send(result);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `POST /otp/verify` — verify an OTP, log in / register, issue tokens. */
  verifyOtp = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const idempotencyKey = this.requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return reply;

    const parsed = verifyOtpSchema.safeParse(request.body);
    if (!parsed.success) {
      return replyAuthError(request, reply, 'VALIDATION', 'Request validation failed', {
        details: parsed.error.issues,
      });
    }
    try {
      const result = await this.authService.verifyOtp(
        {
          phoneNumber: parsed.data.phoneNumber,
          code: parsed.data.code,
          device: toDeviceContext(parsed.data.device),
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          ...(parsed.data.challengeId != null ? { challengeId: parsed.data.challengeId } : {}),
        },
        idempotencyKey,
      );
      return reply.status(200).send(result);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `POST /token/refresh` — rotate the session. */
  refresh = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const idempotencyKey = this.requireIdempotencyKey(request, reply);
    if (!idempotencyKey) return reply;

    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return replyAuthError(request, reply, 'VALIDATION', 'Request validation failed', {
        details: parsed.error.issues,
      });
    }
    try {
      const result = await this.authService.refresh(parsed.data.refreshToken, idempotencyKey);
      return reply.status(200).send(result);
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `POST /logout` — end the current session, or all (`allDevices`). Auth required. */
  logout = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');

    const parsed = logoutSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return replyAuthError(request, reply, 'VALIDATION', 'Request validation failed', {
        details: parsed.error.issues,
      });
    }
    try {
      if (parsed.data?.allDevices) await this.authService.logoutAll(auth.userId);
      else await this.authService.logout(auth.sid);
      return reply.status(204).send();
    } catch (err) {
      return this.handle(request, reply, err);
    }
  };

  /** `GET /me/sessions` — list the caller's active sessions. Auth required. */
  listSessions = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const sessions = await this.authService.listSessions(auth.userId);
    return reply.status(200).send({ sessions: sessions.map((s) => toSessionDto(s, auth.sid)) });
  };

  /** `DELETE /me/sessions/:id` — revoke one of the caller's sessions. Auth required. */
  revokeSession = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const { id } = request.params as { id: string };
    const revoked = await this.authService.revokeSession(auth.userId, id);
    if (!revoked) return replyAuthError(request, reply, 'VALIDATION', 'Session not found', {});
    return reply.status(204).send();
  };

  /** `DELETE /me/sessions` — revoke all of the caller's sessions. Auth required. */
  revokeAllSessions = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    await this.authService.logoutAll(auth.userId);
    return reply.status(204).send();
  };

  /** `GET /me/devices` — list the caller's bound devices. Auth required. */
  listDevices = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const { devices, currentDeviceId } = await this.authService.listDevices(auth.userId, auth.sid);
    return reply.status(200).send({ devices: devices.map((d) => toDeviceDto(d, currentDeviceId)) });
  };

  /**
   * `DELETE /me/devices/:id` — revoke one of the caller's devices. Auth required.
   *
   * Every session bound to the device ends with it (R-DEVICE-3, AUTH-INV-6), so
   * revoking the device the caller is holding signs the caller out — that is the
   * intended behaviour for a lost-phone flow, and the `current` flag on the list
   * is what lets a client warn first.
   */
  revokeDevice = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const { id } = request.params as { id: string };
    const revoked = await this.authService.revokeDevice(auth.userId, id);
    // Unknown and not-owned are the same answer: confirming that someone else's
    // device exists is an enumeration oracle, exactly as it is for sessions.
    if (revoked === null) return replyAuthError(request, reply, 'VALIDATION', 'Device not found');
    return reply.status(204).send();
  };

  /** Read and require the `Idempotency-Key` header (doc 04 §2.2/2.3). */
  private requireIdempotencyKey(request: FastifyRequest, reply: FastifyReply): string | null {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      replyAuthError(request, reply, 'VALIDATION', 'Idempotency-Key header is required');
      return null;
    }
    return key;
  }

  /** Map an `AuthError` to the doc-05 envelope; rethrow anything unexpected. */
  private handle(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof AuthError) return replyFromAuthError(request, reply, err);
    throw err;
  }
}
