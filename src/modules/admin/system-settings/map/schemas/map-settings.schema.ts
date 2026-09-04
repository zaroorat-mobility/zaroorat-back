import { z } from 'zod';
import { MAP_CAPABILITY } from '@modules/location/types/map-capabilities.types.js';

export const mapProviderNameSchema = z.enum(['ola', 'google', 'mappls']);

const mapCapabilitySchema = z.enum([
  MAP_CAPABILITY.AUTOCOMPLETE,
  MAP_CAPABILITY.PLACE_DETAILS,
  MAP_CAPABILITY.GEOCODE,
  MAP_CAPABILITY.REVERSE_GEOCODE,
  MAP_CAPABILITY.ROUTE,
  MAP_CAPABILITY.ROUTE_MATRIX,
  MAP_CAPABILITY.SNAP_TO_ROAD,
]);

export const updateMapSettingsBodySchema = z.object({
  primaryProvider: mapProviderNameSchema,
  expectedVersion: z.number().int().positive().optional(),
  fallback: z
    .object({
      enabled: z.boolean().optional(),
      byCapability: z.record(mapCapabilitySchema, z.array(mapProviderNameSchema)).optional(),
    })
    .optional(),
  providers: z
    .object({
      ola: z
        .object({
          enabled: z.boolean().optional(),
          apiKey: z.string().optional(),
          clientSdkKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
      google: z
        .object({
          enabled: z.boolean().optional(),
          apiKey: z.string().optional(),
          clientSdkKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
      mappls: z
        .object({
          enabled: z.boolean().optional(),
          restApiKey: z.string().optional(),
          clientId: z.string().optional(),
          clientSecret: z.string().optional(),
          clientSdkKey: z.string().optional(),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
    })
    .optional(),
});

export const testProviderHealthBodySchema = z.object({
  providerName: mapProviderNameSchema,
  apiKey: z.string().optional(),
  restApiKey: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  baseUrl: z.string().url().optional(),
});
