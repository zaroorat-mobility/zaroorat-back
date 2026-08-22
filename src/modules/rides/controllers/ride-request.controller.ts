import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { RedisService, IDEMPOTENCY_OPERATIONS } from '@core/cache';
import { RideService } from '../services/ride.service.js';
import { quoteFareSchema, createRideRequestSchema } from '../schemas/ride.schemas.js';
import { RIDE_REQUEST_IDEMPOTENCY_TTL_SECONDS } from '../constants/ride.constants.js';
export class RideRequestController {
  constructor(
    private readonly rideService: RideService,
    private readonly redisService: RedisService,
  ) {}
  async quote(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = quoteFareSchema.parse(req.body);
    const quote = await this.rideService.request.createQuote({
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      ...(body.vehicleTypeId !== undefined ? { vehicleTypeId: body.vehicleTypeId } : {}),
      ...(body.cityId !== undefined ? { cityId: body.cityId } : {}),
      ...(body.dropLat !== undefined ? { dropLat: body.dropLat } : {}),
      ...(body.dropLng !== undefined ? { dropLng: body.dropLng } : {}),
    });
    reply.send({ data: quote });
  }
  async createRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const body = createRideRequestSchema.parse(req.body);
    const create = () =>
      this.rideService.request.createRequest({
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
    // Optional, unlike payments' mandatory Idempotency-Key: a client retrying
    // a timed-out POST /rides/requests with the same key gets back the
    // original request instead of creating a second one. Without a key this
    // behaves exactly as before.
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const request = idempotencyKey
      ? await this.redisService.idempotency.runOnce(
          IDEMPOTENCY_OPERATIONS.RIDE_REQUEST,
          `${customerId}:${idempotencyKey}`,
          RIDE_REQUEST_IDEMPOTENCY_TTL_SECONDS,
          create,
        )
      : await create();
    reply.send({ data: request });
  }
  async cancelRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const { id } = req.params as { id: string };
    const request = await this.rideService.request.cancelRequest(id, customerId);
    reply.send({ data: request });
  }
}
