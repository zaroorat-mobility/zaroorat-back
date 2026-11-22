import { z } from 'zod';
import {
  LATITUDE_MAX,
  LATITUDE_MIN,
  LONGITUDE_MAX,
  LONGITUDE_MIN,
} from '../constants/geo.constants.js';
export const latitudeSchema = z.number().min(LATITUDE_MIN).max(LATITUDE_MAX);
export const longitudeSchema = z.number().min(LONGITUDE_MIN).max(LONGITUDE_MAX);
export const coordinateSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});
export type CoordinateInput = z.infer<typeof coordinateSchema>;
