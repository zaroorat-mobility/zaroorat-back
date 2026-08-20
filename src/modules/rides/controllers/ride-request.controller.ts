import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { RideService } from '../services/ride.service.js';
import { quoteFareSchema, createRideRequestSchema } from '../schemas/ride.schemas.js';
export class RideRequestController {
  constructor(private readonly rideService: RideService) {}
  async quote(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = quoteFareSchema.parse(req.body);
    const quote = await this.rideService.request.createQuote({
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      vehicleTypeId: body.vehicleTypeId,
      ...(body.dropLat !== undefined ? { dropLat: body.dropLat } : {}),
      ...(body.dropLng !== undefined ? { dropLng: body.dropLng } : {}),
    });
    reply.send({ data: quote });
  }
  async createRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const body = createRideRequestSchema.parse(req.body);
    const request = await this.rideService.request.createRequest({
      customerId,
      vehicleTypeId: body.vehicleTypeId,
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      ...(body.pickupAddress !== undefined ? { pickupAddress: body.pickupAddress } : {}),
      ...(body.dropLat !== undefined ? { dropLat: body.dropLat } : {}),
      ...(body.dropLng !== undefined ? { dropLng: body.dropLng } : {}),
      ...(body.dropAddress !== undefined ? { dropAddress: body.dropAddress } : {}),
      ...(body.paymentMethod !== undefined ? { paymentMethod: body.paymentMethod } : {}),
      ...(body.promoCode !== undefined ? { promoCode: body.promoCode } : {}),
    });
    reply.send({ data: request });
  }
}
