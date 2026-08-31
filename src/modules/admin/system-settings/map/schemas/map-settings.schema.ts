import { z } from 'zod';

export const mapProviderNameSchema = z.enum(['ola', 'google', 'mappls']);

export const updateMapSettingsBodySchema = z.object({
  primaryProvider: mapProviderNameSchema,
  fallbackProviders: z.array(mapProviderNameSchema),
  expectedVersion: z.number().int().positive().optional(),
  providers: z
    .object({
      ola: z
        .object({
          enabled: z.boolean().optional(),
          apiKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
      google: z
        .object({
          enabled: z.boolean().optional(),
          apiKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
      mappls: z
        .object({
          enabled: z.boolean().optional(),
          clientId: z.string().optional(),
          clientSecret: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
    })
    .optional(),
});

export const testProviderHealthBodySchema = z.object({
  providerName: mapProviderNameSchema,
  apiKey: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  baseUrl: z.string().url().optional(),
});
