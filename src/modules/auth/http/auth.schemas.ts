import { z } from 'zod';

/** E.164 phone number (`+` followed by 7–15 digits, no leading zero). */
const phoneNumber = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'phoneNumber must be E.164 (e.g. +919876543210)');

/** Device context reported by the client at send/verify. */
const deviceSchema = z
  .object({
    deviceId: z.string().min(1).max(128).optional(),
    platform: z.enum(['IOS', 'ANDROID', 'WEB']).optional(),
    appVersion: z.string().max(32).optional(),
    osVersion: z.string().max(32).optional(),
    fingerprint: z.string().max(256).optional(),
    isRooted: z.boolean().optional(),
    isJailbroken: z.boolean().optional(),
    fcmToken: z.string().max(512).optional(),
  })
  .optional();

/** `POST /api/v1/auth/otp/send`. */
export const sendOtpSchema = z.object({
  phoneNumber,
  device: deviceSchema,
});

/** `POST /api/v1/auth/otp/verify`. */
export const verifyOtpSchema = z.object({
  phoneNumber,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  challengeId: z.string().min(1).optional(),
  device: deviceSchema,
});

/** `POST /api/v1/auth/token/refresh`. */
export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

/** `POST /api/v1/auth/logout` (body optional). */
export const logoutSchema = z
  .object({
    allDevices: z.boolean().optional(),
  })
  .optional();

export type SendOtpBody = z.infer<typeof sendOtpSchema>;
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
