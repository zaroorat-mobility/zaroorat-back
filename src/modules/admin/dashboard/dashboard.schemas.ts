import { z } from 'zod';

/** Query validation for the dashboard routes. A ZodError is answered with 400 (dashboard.routes.ts). */

export const financialAnalyticsQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('7d'),
});

export type FinancialAnalyticsQuery = z.infer<typeof financialAnalyticsQuerySchema>;

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const VIEWPORT_RE = new RegExp(`^${NUMBER},${NUMBER},${NUMBER},${NUMBER}$`);

/** "minLat,minLng,maxLat,maxLng" with valid, ordered coordinates. */
export function parseViewport(viewport: string) {
  const [minLat, minLng, maxLat, maxLng] = viewport.split(',').map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { minLat, minLng, maxLat, maxLng };
}

export const liveDriversQuerySchema = z.object({
  viewport: z
    .string()
    .trim()
    .regex(VIEWPORT_RE, 'viewport must be "minLat,minLng,maxLat,maxLng"')
    .refine((v) => {
      const b = parseViewport(v);
      return (
        b.minLat >= -90 &&
        b.maxLat <= 90 &&
        b.minLng >= -180 &&
        b.maxLng <= 180 &&
        b.minLat <= b.maxLat &&
        b.minLng <= b.maxLng
      );
    }, 'viewport coordinates are out of range or not ordered')
    .optional(),
  status: z.enum(['ONLINE', 'ON_TRIP', 'BUSY', 'BREAK', 'OFFLINE']).optional(),
  mode: z.enum(['Car', 'Auto', 'Bike']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type LiveDriversQuery = z.infer<typeof liveDriversQuerySchema>;

export const ACTIVITY_TYPES = [
  'DRIVER_REGISTERED',
  'KYC_APPROVED',
  'DRIVER_VERIFIED',
  'DRIVER_REJECTED',
  'RIDE_COMPLETED',
  'RIDE_CANCELLED',
  'PAYMENT_SETTLED',
  'VEHICLE_ADDED',
  'HIGH_CANCELLATION_RATE',
  'SYSTEM_ALERT',
  'ADMIN_ACTION',
] as const;

/** Activity item ids are "<source>:<uuid>"; sources sort as admin < kyc < reg < ride. */
export const ACTIVITY_SOURCES = ['admin', 'kyc', 'reg', 'ride'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CURSOR_RE = new RegExp(
  `^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\|(${ACTIVITY_SOURCES.join('|')}):(${UUID})$`,
);

export interface ActivityCursor {
  at: Date;
  source: ActivitySource;
  rawId: string;
}

/** Parses a cursor already validated by `activityQuerySchema`. */
export function parseActivityCursor(cursor: string): ActivityCursor {
  const m = CURSOR_RE.exec(cursor)!;
  return { at: new Date(m[1]!), source: m[2] as ActivitySource, rawId: m[3]! };
}

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(CURSOR_RE, 'cursor must be a value returned as nextCursor')
    .refine((c) => !Number.isNaN(Date.parse(c.split('|')[0]!)), 'cursor timestamp is invalid')
    .optional(),
  type: z.enum(ACTIVITY_TYPES).optional(),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;
