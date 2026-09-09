import { z } from 'zod';

export const appClientSchema = z.enum(['driver', 'rider', 'admin']);
export const colorSchemeSchema = z.enum(['light', 'dark']);

export const getAppConfigQuerySchema = z.object({
  app: appClientSchema,
  locale: z.string().min(2).max(10).default('en'),
  platform: z.string().optional(),
});

export const updateThemeSchema = z.object({
  app: appClientSchema,
  colorScheme: colorSchemeSchema,
  tokens: z.record(z.string(), z.unknown()).optional(),
  components: z.record(z.string(), z.unknown()).optional(),
});

export const updateFontsSchema = z.object({
  app: appClientSchema,
  fonts: z.array(
    z.object({
      family: z.string().min(1).max(120),
      weight: z.string().min(1).max(40),
      style: z.string().min(1).max(40).optional(),
      source: z.enum(['BUNDLED', 'GOOGLE', 'REMOTE']).optional(),
      url: z.string().url().nullable().optional(),
      isActive: z.boolean().optional(),
    }),
  ),
});

export const updateLocaleSchema = z.object({
  code: z.string().min(2).max(10),
  label: z.string().min(1).max(80),
  nativeLabel: z.string().min(1).max(80),
  isRtl: z.boolean().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const createLocaleSchema = updateLocaleSchema;

export const upsertTranslationsSchema = z.object({
  app: appClientSchema,
  locale: z.string().min(2).max(10),
  entries: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        value: z.string(),
      }),
    )
    .min(1),
});

export const resetThemeSchema = z.object({
  app: appClientSchema,
  colorScheme: colorSchemeSchema,
  tokens: z.record(z.string(), z.unknown()).optional(),
  components: z.record(z.string(), z.unknown()).optional(),
});

export type GetAppConfigQuery = z.infer<typeof getAppConfigQuerySchema>;
export type UpdateThemeBody = z.infer<typeof updateThemeSchema>;
export type UpdateFontsBody = z.infer<typeof updateFontsSchema>;
export type UpdateLocaleBody = z.infer<typeof updateLocaleSchema>;
export type UpsertTranslationsBody = z.infer<typeof upsertTranslationsSchema>;
export type ResetThemeBody = z.infer<typeof resetThemeSchema>;
