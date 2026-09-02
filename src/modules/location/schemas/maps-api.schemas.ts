import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '../schemas/geo.schemas.js';
import { mapProviderNameSchema } from '@modules/admin/system-settings/map/schemas/map-settings.schema.js';

export const autocompleteQuerySchema = z.object({
  input: z.string().min(1).max(200),
  latitude: latitudeSchema.optional(),
  longitude: longitudeSchema.optional(),
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
  placeId: z.string().min(1).max(256),
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
