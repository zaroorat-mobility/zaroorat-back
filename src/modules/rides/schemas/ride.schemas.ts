import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '@modules/location';
import { ridePinConfig } from '@config';
/// Drop coordinates are required, not optional.
///
/// They were optional here while every path behind them insisted on having
/// them: `calculateFareQuote` refuses to price an open-ended trip rather than
/// assume a default distance, and `RideQuote` has no shape for a missing drop.
/// So a request that this schema accepted died on a bare `Error` deeper in, and
/// `handleRideError` — which only maps coded errors — turned it into **500
/// INTERNAL**. A client sending exactly what the schema advertised was told the
/// server had broken. Required here, it is a 400 VALIDATION naming the fields,
/// like every other required field on these routes.
export const quoteFareSchema = z.object({
  pickupLat: latitudeSchema,
  pickupLng: longitudeSchema,
  dropLat: latitudeSchema,
  dropLng: longitudeSchema,
  /// Optional: omit to price every active category in one call (the customer
  /// app's picker), supply one to price just that category.
  vehicleTypeId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  promoCode: z.string().max(50).optional(),
  cityCode: z.string().trim().max(40).optional(),
});
export type QuoteFareBody = z.infer<typeof quoteFareSchema>;
export const createRideRequestSchema = z.object({
  vehicleTypeId: z.string().uuid(),
  pickupLat: latitudeSchema,
  pickupLng: longitudeSchema,
  pickupAddress: z.string().max(255).optional(),
  // Required for the same reason as on `quoteFareSchema`: booking priced the
  // ride through the same `calculateFareQuote`, so a request without a drop was
  // a 500 too. `dropAddress` stays optional — a label is not a location.
  dropLat: latitudeSchema,
  dropLng: longitudeSchema,
  dropAddress: z.string().max(255).optional(),
  paymentMethod: z.enum(['CASH', 'WALLET', 'CARD', 'UPI']).optional(),
  promoCode: z.string().max(50).optional(),
});
export type CreateRideRequestBody = z.infer<typeof createRideRequestSchema>;
export const acceptRideRequestSchema = z.object({
  requestId: z.string().uuid(),
  vehicleId: z.string().uuid(),
});
export type AcceptRideRequestBody = z.infer<typeof acceptRideRequestSchema>;
/// The rider's standing Ride PIN, recited to the driver at the pickup point.
///
/// A string of digits, never a number: `Number('0827')` is 827, and a PIN that
/// silently loses its leading zero is a rider who cannot start a ride. Digits
/// are enforced here as well as length — the OTP field this replaces checked
/// only length, so `"abcdef"` passed validation and reached the verifier.
export const startRideSchema = z.object({
  pin: z.string().regex(new RegExp(`^[0-9]{${ridePinConfig.length}}$`), {
    message: `PIN must be ${ridePinConfig.length} digits`,
  }),
});
export type StartRideBody = z.infer<typeof startRideSchema>;
export const completeRideSchema = z.object({
  actualDistanceKm: z.number().nonnegative(),
  actualDurationMin: z.number().int().nonnegative(),
});
export type CompleteRideBody = z.infer<typeof completeRideSchema>;
export const cancelRideSchema = z.object({
  reasonCode: z.string().max(50),
  reasonText: z.string().max(255).optional(),
});
export type CancelRideBody = z.infer<typeof cancelRideSchema>;

/// A reason is optional and free-text: it feeds driver-quality analytics, not
/// any decision the dispatcher makes.
export const rejectOfferSchema = z.object({
  reason: z.string().max(255).optional(),
});
export type RejectOfferBody = z.infer<typeof rejectOfferSchema>;
