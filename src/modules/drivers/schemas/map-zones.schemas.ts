import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '@modules/location';
import {
  MAP_LAYERS,
  MAX_VIEWPORT_SPAN_DEGREES,
  type MapLayer,
} from '../services/map-zones/map-zones.logic.js';

const lat = z.coerce.number().pipe(latitudeSchema);
const lng = z.coerce.number().pipe(longitudeSchema);

/// `GET /drivers/me/map-zones` — the visible map box, and optionally which layers
/// to compute (`layers=surge,restricted`); all of them when omitted.
export const mapZonesQuerySchema = z
  .object({
    minLat: lat,
    minLng: lng,
    maxLat: lat,
    maxLng: lng,
    layers: z.string().max(100).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.minLat >= q.maxLat) {
      ctx.addIssue({ code: 'custom', path: ['minLat'], message: 'minLat must be below maxLat' });
    }
    if (q.minLng >= q.maxLng) {
      ctx.addIssue({ code: 'custom', path: ['minLng'], message: 'minLng must be below maxLng' });
    }
    if (
      q.maxLat - q.minLat > MAX_VIEWPORT_SPAN_DEGREES ||
      q.maxLng - q.minLng > MAX_VIEWPORT_SPAN_DEGREES
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLat'],
        message: `viewport may span at most ${MAX_VIEWPORT_SPAN_DEGREES} degrees`,
      });
    }
    const unknown = (q.layers?.split(',') ?? [])
      .map((l) => l.trim())
      .filter((l) => l && !(MAP_LAYERS as readonly string[]).includes(l));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['layers'],
        message: `unknown layer(s): ${unknown.join(', ')}`,
      });
    }
  })
  .transform((q) => {
    const requested = q.layers
      ?.split(',')
      .map((l) => l.trim())
      .filter(Boolean) as MapLayer[] | undefined;
    return {
      viewport: { minLat: q.minLat, minLng: q.minLng, maxLat: q.maxLat, maxLng: q.maxLng },
      layers: new Set<MapLayer>(requested && requested.length > 0 ? requested : MAP_LAYERS),
    };
  });
