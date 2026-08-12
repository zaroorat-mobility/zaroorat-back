import { z } from 'zod';
import { RIDE_OTP_LENGTH } from '../constants/ride.constants.js';

export const quoteFareSchema = z.object({
  pickupLat: z.number().min(-90).max(90),
  pickupLng: z.number().min(-180).max(180),
  dropLat: z.number().min(-90).max(90).optional(),
  dropLng: z.number().min(-180).max(180).optional(),
  vehicleTypeId: z.string().uuid(),
});

export type QuoteFareBody = z.infer<typeof quoteFareSchema>;

export const createRideRequestSchema = z.object({
  vehicleTypeId: z.string().uuid(),
  pickupLat: z.number().min(-90).max(90),
  pickupLng: z.number().min(-180).max(180),
  pickupAddress: z.string().max(255).optional(),
  dropLat: z.number().min(-90).max(90).optional(),
  dropLng: z.number().min(-180).max(180).optional(),
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
