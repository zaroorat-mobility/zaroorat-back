import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '../schemas/geo.schemas.js';
import { mapProviderNameSchema } from '@modules/admin/system-settings/map/schemas/map-settings.schema.js';

/// Google's session token rule: URL- and filename-safe, at most 36 characters
/// (a UUID fits).
const sessionTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,36}$/)
  .optional();

export const autocompleteQuerySchema = z.object({
  input: z.string().min(1).max(200),
  // Query-string values are always strings ("34.06"): convert, then range-check.
  latitude: z.coerce.number().pipe(latitudeSchema).optional(),
  longitude: z.coerce.number().pipe(longitudeSchema).optional(),
  sessionToken: sessionTokenSchema,
});

export const placeDetailsQuerySchema = z.object({
  sessionToken: sessionTokenSchema,
});

export const geocodeBodySchema = z.object({
  address: z.string().min(1).max(500),
});

export const reverseGeocodeBodySchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});

export const routeBodySchema = z.object({
  originLat: latitudeSchema,
  originLng: longitudeSchema,
  destinationLat: latitudeSchema,
  destinationLng: longitudeSchema,
});

export const placeDetailsParamsSchema = z.object({
  provider: mapProviderNameSchema,
  // The id is interpolated into the upstream URL path, so only URL-safe ids.
  placeId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});

export const routeMatrixBodySchema = z.object({
  origins: z
    .array(z.object({ latitude: latitudeSchema, longitude: longitudeSchema }))
    .min(1)
    .max(25),
  destinations: z
    .array(z.object({ latitude: latitudeSchema, longitude: longitudeSchema }))
    .min(1)
    .max(25),
});
