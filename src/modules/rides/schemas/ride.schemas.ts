import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '@modules/geo';
import { RIDE_OTP_LENGTH } from '../constants/ride.constants.js';
export const quoteFareSchema = z.object({
  pickupLat: latitudeSchema,
  pickupLng: longitudeSchema,
  dropLat: latitudeSchema.optional(),
  dropLng: longitudeSchema.optional(),
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
  dropLat: latitudeSchema.optional(),
  dropLng: longitudeSchema.optional(),
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
export const startRideSchema = z.object({
  otpCode: z.string().length(RIDE_OTP_LENGTH, { message: `OTP must be ${RIDE_OTP_LENGTH} digits` }),
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
