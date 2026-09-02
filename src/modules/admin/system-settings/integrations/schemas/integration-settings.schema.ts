import { z } from 'zod';

export const updatePaymentSettingsSchema = z.object({
  defaultGateway: z.enum(['mock', 'razorpay', 'stripe']).optional(),
  defaultCurrency: z.string().length(3).optional(),
  razorpayKeyId: z.string().optional(),
  razorpayKeySecret: z.string().optional(),
  stripeSecretKey: z.string().optional(),
  webhookSecret: z.string().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const updateSmsSettingsSchema = z.object({
  provider: z.enum(['mock', 'msg91']).optional(),
  msg91AuthKey: z.string().optional(),
  msg91SenderId: z.string().max(12).optional(),
  msg91OtpTemplateId: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(30_000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const updatePushSettingsSchema = z.object({
  provider: z.enum(['mock']).optional(),
  fcmServerKey: z.string().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const updateEmailSettingsSchema = z.object({
  provider: z.enum(['smtp']).optional(),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().min(1).max(65_535).optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  fromAddress: z.string().email().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const integrationTestSchema = z.object({
  testPhone: z.string().optional(),
  testEmail: z.string().email().optional(),
});
