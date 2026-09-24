import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { RedisService, IDEMPOTENCY_OPERATIONS } from '@core/cache';
import { RideService } from '../services/ride.service.js';
import {
  quoteFareSchema,
  createRideRequestSchema,
  boostRequestSchema,
  changeDestinationQuoteSchema,
  confirmDestinationSchema,
} from '../schemas/ride.schemas.js';
import { RIDE_REQUEST_IDEMPOTENCY_TTL_SECONDS } from '../constants/ride.constants.js';
import { toClientRideRequestView } from '../presenters/ride-client.presenter.js';
export class RideRequestController {
  constructor(
    private readonly rideService: RideService,
    private readonly redisService: RedisService,
  ) {}
  async quote(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = quoteFareSchema.parse(req.body);
    const userId = req.auth?.userId;
    const quote = await this.rideService.request.createQuote({
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      dropLat: body.dropLat,
      dropLng: body.dropLng,
      ...(body.vehicleTypeId !== undefined ? { vehicleTypeId: body.vehicleTypeId } : {}),
      ...(body.cityId !== undefined ? { cityId: body.cityId } : {}),
      ...(body.dropLat !== undefined ? { dropLat: body.dropLat } : {}),
      ...(body.dropLng !== undefined ? { dropLng: body.dropLng } : {}),
      ...(body.promoCode !== undefined ? { promoCode: body.promoCode } : {}),
      ...(body.cityCode !== undefined ? { cityCode: body.cityCode } : {}),
      ...(body.stops !== undefined
        ? {
            stops: body.stops.map((s) => ({
              lat: s.lat,
              lng: s.lng,
              ...(s.address !== undefined ? { address: s.address } : {}),
            })),
          }
        : {}),
      ...(userId !== undefined ? { userId } : {}),
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
        dropLat: body.dropLat,
        dropLng: body.dropLng,
        ...(body.pickupAddress !== undefined ? { pickupAddress: body.pickupAddress } : {}),
        ...(body.dropAddress !== undefined ? { dropAddress: body.dropAddress } : {}),
        ...(body.paymentMethod !== undefined ? { paymentMethod: body.paymentMethod } : {}),
        ...(body.promoCode !== undefined ? { promoCode: body.promoCode } : {}),
        ...(body.stops !== undefined
          ? {
              stops: body.stops.map((s) => ({
                lat: s.lat,
                lng: s.lng,
                ...(s.address !== undefined ? { address: s.address } : {}),
              })),
            }
          : {}),
        ...(body.passengerName !== undefined ? { passengerName: body.passengerName } : {}),
        ...(body.passengerPhone !== undefined ? { passengerPhone: body.passengerPhone } : {}),
        ...(body.pickupNotes !== undefined ? { pickupNotes: body.pickupNotes } : {}),
        ...(body.scheduledFor !== undefined ? { scheduledFor: body.scheduledFor } : {}),
        ...(body.boostAmount !== undefined ? { boostAmount: body.boostAmount } : {}),
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
  async getActiveRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const request = await this.rideService.request.getActiveRequest(callerId(req));
    reply.send({ data: toClientRideRequestView(request) });
  }

  async getRequestById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const request = await this.rideService.request.getRequestForCustomer(id, callerId(req));
    reply.send({ data: toClientRideRequestView(request) });
  }

  async cancelRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const { id } = req.params as { id: string };
    const request = await this.rideService.request.cancelRequest(id, customerId);
    reply.send({ data: request });
  }
  async boostRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const { id } = req.params as { id: string };
    const body = boostRequestSchema.parse(req.body);
    const result = await this.rideService.request.boostRequest(id, customerId, body.boostAmount);
    reply.send({ data: result });
  }
  async quoteDestination(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const { id } = req.params as { id: string };
    const body = changeDestinationQuoteSchema.parse(req.body);
    const quote = await this.rideService.request.quoteDestinationChange(id, customerId, {
      dropLat: body.dropLat,
      dropLng: body.dropLng,
      ...(body.dropAddress !== undefined ? { dropAddress: body.dropAddress } : {}),
    });
    reply.send({ data: quote });
  }
  async confirmDestination(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const { id } = req.params as { id: string };
    const body = confirmDestinationSchema.parse(req.body);
    const result = await this.rideService.request.confirmDestinationChange(id, customerId, {
      dropLat: body.dropLat,
      dropLng: body.dropLng,
      ...(body.dropAddress !== undefined ? { dropAddress: body.dropAddress } : {}),
      ...(body.expectedFare !== undefined ? { expectedFare: body.expectedFare } : {}),
    });
    reply.send({ data: result });
  }
}
