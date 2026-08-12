import { z } from 'zod';

export const sendOtpResponseSchema = z.object({
  challengeId: z.string(),
  expiresInSec: z.number(),
  resendAvailableInSec: z.number(),
});

export const verifyOtpResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresInSec: z.number(),
  refreshToken: z.string(),
  refreshTokenExpiresInSec: z.number(),
  user: z.object({
    id: z.string(),
    status: z.string(),
    roles: z.array(z.string()),
    isNew: z.boolean(),
  }),
});

export type SendOtpResponse = z.infer<typeof sendOtpResponseSchema>;
export type VerifyOtpResponse = z.infer<typeof verifyOtpResponseSchema>;

export const errorResponseSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Domain error code (e.g. VALIDATION, OTP_INVALID, RATE_LIMITED)',
        },
        messageKey: { type: 'string', description: 'Localization i18n key' },
        message: { type: 'string', description: 'Human-readable message' },
        requestId: { type: 'string', description: 'Trace request identifier' },
        details: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Per-field details. USER sends { field, code, limit? }; AUTH forwards raw ' +
            'validation issues.',
        },
        retryAfterSec: { type: 'number', description: 'Rate limit retry delay in seconds' },
      },
      required: ['code', 'messageKey', 'message', 'requestId'],
    },
  },
  required: ['error'],
} as const;

const deviceBodySchema = {
  type: 'object',
  properties: {
    deviceId: { type: 'string', maxLength: 128, description: 'Unique device identifier' },
    platform: {
      type: 'string',
      enum: ['IOS', 'ANDROID', 'WEB'],
      description: 'Client platform',
    },
    appVersion: { type: 'string', maxLength: 32, description: 'App version string' },
    osVersion: { type: 'string', maxLength: 32, description: 'OS version string' },
    fingerprint: { type: 'string', maxLength: 256, description: 'Device fingerprint hash' },
    isRooted: { type: 'boolean', description: 'Is device rooted (Android)' },
    isJailbroken: { type: 'boolean', description: 'Is device jailbroken (iOS)' },
    fcmToken: { type: 'string', maxLength: 512, description: 'Firebase Cloud Messaging token' },
  },
} as const;

export const sendOtpBodySchema = {
  type: 'object',
  properties: {
    phoneNumber: {
      type: 'string',
      description: 'E.164 phone number, required (e.g. +919876543210)',
    },
    device: deviceBodySchema,
  },
} as const;

export const verifyOtpBodySchema = {
  type: 'object',
  properties: {
    phoneNumber: {
      type: 'string',
      description: 'E.164 phone number, required (e.g. +919876543210)',
    },
    code: { type: 'string', description: '6-digit OTP code, required' },
    challengeId: {
      type: 'string',
      description: 'Opaque challenge ID returned by /otp/send. Bound to this phone and purpose.',
    },
    device: deviceBodySchema,
  },
} as const;

export const refreshBodySchema = {
  type: 'object',
  properties: {
    refreshToken: { type: 'string', description: 'Opaque refresh token, required' },
  },
} as const;

export const logoutBodySchema = {
  type: ['object', 'null'],
  properties: {
    allDevices: {
      type: 'boolean',
      description: 'If true, revokes all sessions for the user across all devices',
    },
  },
} as const;

export const idempotencyHeaderSchema = {
  type: 'object',
  properties: {
    'idempotency-key': {
      type: 'string',
      description: 'Unique key for request idempotency. Required.',
    },
  },
} as const;

export const idParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

export const sendOtpResponse = {
  type: 'object',
  properties: {
    challengeId: { type: 'string', format: 'uuid' },
    expiresInSec: { type: 'integer' },
    resendAvailableInSec: { type: 'integer' },
  },
  required: ['challengeId', 'expiresInSec', 'resendAvailableInSec'],
} as const;

const tokenPairProperties = {
  accessToken: { type: 'string' },
  accessTokenExpiresInSec: { type: 'integer' },
  refreshToken: { type: 'string' },
  refreshTokenExpiresInSec: { type: 'integer' },
} as const;

export const tokenPairResponse = {
  type: 'object',
  properties: tokenPairProperties,
  required: ['accessToken', 'accessTokenExpiresInSec', 'refreshToken', 'refreshTokenExpiresInSec'],
} as const;

export const verifyOtpResponse = {
  type: 'object',
  properties: {
    ...tokenPairProperties,
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['UNVERIFIED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] },
        roles: { type: 'array', items: { type: 'string' } },
        isNew: { type: 'boolean', description: 'True when this call created the account' },
      },
      required: ['id', 'status', 'roles', 'isNew'],
    },
  },
  required: [
    'accessToken',
    'accessTokenExpiresInSec',
    'refreshToken',
    'refreshTokenExpiresInSec',
    'user',
  ],
} as const;

export const sessionListResponse = {
  type: 'object',
  properties: {
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: ['string', 'null'], format: 'uuid' },
          ipAddress: { type: ['string', 'null'] },
          userAgent: { type: ['string', 'null'] },
          loginMethod: { type: ['string', 'null'], description: 'e.g. otp, phone_change' },
          createdAt: { type: 'string', format: 'date-time' },
          lastSeenAt: {
            type: ['string', 'null'],
            format: 'date-time',
            description:
              'Last authenticated request on this session, to the nearest throttle window',
          },
          expiresAt: { type: 'string', format: 'date-time' },
          current: { type: 'boolean', description: 'True for the caller’s own session' },
        },
        required: ['id', 'createdAt', 'expiresAt', 'current'],
      },
    },
  },
  required: ['sessions'],
} as const;

export const deviceListResponse = {
  type: 'object',
  properties: {
    devices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          deviceId: { type: ['string', 'null'], description: 'Client-reported stable id' },
          platform: { type: ['string', 'null'], enum: ['IOS', 'ANDROID', 'WEB', null] },
          trustState: {
            type: 'string',
            enum: ['REGISTERED', 'TRUSTED', 'SUSPICIOUS', 'REVOKED'],
          },
          isRooted: { type: 'boolean' },
          isJailbroken: { type: 'boolean' },
          appVersion: { type: ['string', 'null'] },
          osVersion: { type: ['string', 'null'] },
          lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          current: { type: 'boolean', description: 'True for the device bound to this session' },
        },
        required: ['id', 'trustState', 'isRooted', 'isJailbroken', 'createdAt', 'current'],
      },
    },
  },
  required: ['devices'],
} as const;
