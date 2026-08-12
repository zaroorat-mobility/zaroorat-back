import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { UserDevice, UserSession } from '@core/database/types';
import { IdempotencyInFlightError } from '@core/cache';
import { AuthService, type DeviceContext } from '../services/auth.service';
import { AuthError } from '../errors/auth.errors';
import { replyAuthError, replyFromAuthError } from '../schemas/error-response';
import {
  sendOtpSchema,
  verifyOtpSchema,
  refreshSchema,
  logoutSchema,
} from '../schemas/auth.schemas';

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

export class AuthController {
  constructor(private readonly authService: AuthService) {}

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

  listSessions = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const sessions = await this.authService.listSessions(auth.userId);
    return reply.status(200).send({ sessions: sessions.map((s) => toSessionDto(s, auth.sid)) });
  };

  revokeSession = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const { id } = request.params as { id: string };
    const revoked = await this.authService.revokeSession(auth.userId, id);
    if (!revoked) return replyAuthError(request, reply, 'NOT_FOUND', 'Session not found');
    return reply.status(204).send();
  };

  revokeAllSessions = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    await this.authService.logoutAll(auth.userId);
    return reply.status(204).send();
  };

  listDevices = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const { devices, currentDeviceId } = await this.authService.listDevices(auth.userId, auth.sid);
    return reply.status(200).send({ devices: devices.map((d) => toDeviceDto(d, currentDeviceId)) });
  };

  revokeDevice = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const auth = request.auth;
    if (!auth) return replyAuthError(request, reply, 'TOKEN_INVALID', 'Not authenticated');
    const { id } = request.params as { id: string };
    const revoked = await this.authService.revokeDevice(auth.userId, id);
    if (revoked === null) return replyAuthError(request, reply, 'NOT_FOUND', 'Device not found');
    return reply.status(204).send();
  };

  private requireIdempotencyKey(request: FastifyRequest, reply: FastifyReply): string | null {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      replyAuthError(request, reply, 'VALIDATION', 'Idempotency-Key header is required');
      return null;
    }
    return key;
  }

  private handle(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof AuthError) return replyFromAuthError(request, reply, err);
    if (err instanceof IdempotencyInFlightError) {
      return replyAuthError(request, reply, err.code, err.message);
    }
    throw err;
  }
}
