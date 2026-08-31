import { z } from 'zod';

export const updateGeneralSettingsSchema = z.object({
  platformName: z.string().min(1).max(120).optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  supportPhone: z.string().max(20).optional(),
  supportEmail: z.string().email().or(z.literal('')).optional(),
  defaultLanguage: z.string().min(2).max(10).optional(),
  timezone: z.string().min(1).max(64).optional(),
  currency: z.string().length(3).optional(),
});

export const updateRideSettingsSchema = z.object({
  requestExpiryMinutes: z.number().int().min(1).max(60).optional(),
  dispatchTimeoutSeconds: z.number().int().min(5).max(300).optional(),
  dispatchBatchSize: z.number().int().min(1).max(20).optional(),
  searchRadiusMeters: z.number().int().min(500).max(50000).optional(),
  maxSearchRadiusMeters: z.number().int().min(1000).max(100000).optional(),
  cancellationGraceMinutes: z.number().int().min(0).max(30).optional(),
  defaultCancellationFee: z.number().min(0).max(10000).optional(),
});

export const updateOtpSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  codeLength: z.number().int().min(4).max(8).optional(),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
  maxVerifyAttempts: z.number().int().min(1).max(10).optional(),
  lockoutSeconds: z.number().int().min(60).max(86400).optional(),
  resendIntervalSeconds: z.number().int().min(30).max(600).optional(),
});

export const updateOnboardingSettingsSchema = z.object({
  driverRequiredDocuments: z.array(z.string()).optional(),
  vehicleRequiredDocuments: z.array(z.string()).optional(),
  driverDocExpiryWarningDays: z.number().int().min(1).max(365).optional(),
  requireApprovedDocuments: z.boolean().optional(),
});

export const updateFeatureFlagSchema = z.object({
  key: z.string().min(1),
  status: z.enum(['ON', 'OFF', 'PARTIAL']).optional(),
  rolloutPercentage: z.number().int().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const updateFeatureFlagsSchema = z.object({
  flags: z.array(updateFeatureFlagSchema).min(1),
});

export const updateMaintenanceSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().max(500).optional(),
  allowAdminAccess: z.boolean().optional(),
  schedule: z
    .object({
      title: z.string().min(1).max(120),
      description: z.string().max(500).optional(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      affectedServices: z.array(z.string()).optional(),
    })
    .optional(),
});

export type UpdateGeneralSettingsBody = z.infer<typeof updateGeneralSettingsSchema>;
export type UpdateRideSettingsBody = z.infer<typeof updateRideSettingsSchema>;
export type UpdateOtpSettingsBody = z.infer<typeof updateOtpSettingsSchema>;
export type UpdateOnboardingSettingsBody = z.infer<typeof updateOnboardingSettingsSchema>;
export type UpdateFeatureFlagsBody = z.infer<typeof updateFeatureFlagsSchema>;
export type UpdateMaintenanceSettingsBody = z.infer<typeof updateMaintenanceSettingsSchema>;
