import { z } from 'zod';

import { E164_PATTERN } from '@shared/validation';

const phoneNumber = z
  .string()
  .regex(E164_PATTERN, 'phoneNumber must be E.164 (e.g. +919876543210)');

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

export const sendOtpSchema = z.object({
  phoneNumber,
  device: deviceSchema,
});

export const verifyOtpSchema = z.object({
  phoneNumber,
  code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  challengeId: z.string().min(1).optional(),
  device: deviceSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutSchema = z
  .object({
    allDevices: z.boolean().optional(),
  })
  .optional();

export type SendOtpBody = z.infer<typeof sendOtpSchema>;
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
