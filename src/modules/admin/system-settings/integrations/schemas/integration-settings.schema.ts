import { z } from 'zod';

// Cashfree is deliberately absent: not exposed or selectable for now.
const paymentGatewayNameSchema = z.enum(['mock', 'razorpay', 'stripe']);
const paymentEnvironmentSchema = z.enum(['sandbox', 'live']);

export const updatePaymentSettingsSchema = z.object({
  defaultCurrency: z.string().length(3).optional(),
  // The ONE gateway every new subscription payment and commission-wallet
  // recharge automatically uses — a single value, not a per-purpose map, so
  // "activate both at once" cannot even be expressed.
  activeProvider: paymentGatewayNameSchema.optional(),
  providers: z
    .object({
      razorpay: z
        .object({
          enabled: z.boolean().optional(),
          environment: paymentEnvironmentSchema.optional(),
          keyId: z.string().optional(),
          keySecret: z.string().optional(),
          webhookSecret: z.string().optional(),
        })
        .optional(),
      stripe: z
        .object({
          enabled: z.boolean().optional(),
          environment: paymentEnvironmentSchema.optional(),
          secretKey: z.string().optional(),
          webhookSecret: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export const paymentIntegrationTestSchema = z.object({
  provider: paymentGatewayNameSchema.optional(),
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
