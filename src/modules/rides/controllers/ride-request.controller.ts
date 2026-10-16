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
    if (!request) {
      return reply.send({ data: null });
    }
    const stats = await this.rideService.request.getOfferStatsForRequest(request.id);
    reply.send({ data: toClientRideRequestView(request, stats) });
  }

  async getRequestById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const request = await this.rideService.request.getRequestForCustomer(id, callerId(req));
    if (!request) {
      return reply.send({ data: null });
    }
    const stats = await this.rideService.request.getOfferStatsForRequest(request.id);
    reply.send({ data: toClientRideRequestView(request, stats) });
  }

  async cancelRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const customerId = callerId(req);
    const { id } = req.params as { id: string };
    const request = await this.rideService.request.cancelRequest(id, customerId);
    reply.send({ data: request });
  }

  async nearbyDrivers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = req.query as Record<string, unknown>;
    const lat = Number(query.lat ?? query.latitude ?? query.pickupLat);
    const lng = Number(query.lng ?? query.longitude ?? query.pickupLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'lat and lng query params are required',
          requestId: req.id,
        },
      });
      return;
    }
    const params: {
      lat: number;
      lng: number;
      limit?: number;
      radiusMeters?: number;
      vehicleTypeId?: string;
      vehicleTypeCode?: string;
    } = { lat, lng };
    const limitRaw = query.limit != null ? Number(query.limit) : NaN;
    const radiusRaw =
      query.radiusMeters != null
        ? Number(query.radiusMeters)
        : query.radiusKm != null
          ? Number(query.radiusKm) * 1000
          : NaN;
    if (Number.isFinite(limitRaw)) params.limit = limitRaw;
    if (Number.isFinite(radiusRaw)) params.radiusMeters = radiusRaw;
    if (typeof query.vehicleTypeId === 'string' && query.vehicleTypeId.trim()) {
      params.vehicleTypeId = query.vehicleTypeId.trim();
    }
    if (typeof query.vehicleTypeCode === 'string' && query.vehicleTypeCode.trim()) {
      params.vehicleTypeCode = query.vehicleTypeCode.trim();
    }
    const data = await this.rideService.request.findNearbyDrivers(params);
    reply.send({ data });
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
