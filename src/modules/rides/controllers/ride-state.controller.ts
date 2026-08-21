import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerHasRole, callerId } from '@core/auth';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { RideService } from '../services/ride.service.js';
import { RideDispatchRepository } from '../repositories/ride-dispatch.repository.js';
import { RatingService } from '../services/rating/rating.service.js';
import {
  acceptRideRequestSchema,
  startRideSchema,
  completeRideSchema,
  cancelRideSchema,
  submitRatingSchema,
} from '../schemas/ride.schemas.js';
import { DriverNotFoundError } from '@modules/drivers/errors/driver.errors.js';
export class RideStateController {
  constructor(
    private readonly rideService: RideService,
    private readonly driverRepository: DriverRepository,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly ratingService: RatingService,
  ) {}
  private async actingDriverId(req: FastifyRequest): Promise<string> {
    const userId = callerId(req);
    const driver = await this.driverRepository.findByUserId(userId);
    if (!driver) throw new DriverNotFoundError(userId);
    return driver.id;
  }
  async listOffers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const offers = await this.dispatchRepo.findPendingForDriver(driverId);
    reply.send({ data: offers });
  }
  async accept(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const body = acceptRideRequestSchema.parse(req.body);
    const result = await this.rideService.lifecycle.acceptRideRequest({
      requestId: body.requestId,
      driverId,
      vehicleId: body.vehicleId,
    });
    reply.send({ data: result });
  }
  async arrive(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const ride = await this.rideService.lifecycle.markDriverArrived(id, driverId);
    reply.send({ data: ride });
  }
  async start(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const body = startRideSchema.parse(req.body);
    const ride = await this.rideService.lifecycle.startRide(id, driverId, body.otpCode);
    reply.send({ data: ride });
  }
  async complete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const body = completeRideSchema.parse(req.body);
    const ride = await this.rideService.lifecycle.completeRide(
      id,
      driverId,
      body.actualDistanceKm,
      body.actualDurationMin,
    );
    reply.send({ data: ride });
  }
  async cancel(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as {
      id: string;
    };
    const body = cancelRideSchema.parse(req.body);
    if (callerHasRole(req, 'driver')) {
      const driverId = await this.actingDriverId(req);
      const ride = await this.rideService.lifecycle.cancelRide(
        id,
        'DRIVER',
        driverId,
        body.reasonCode,
        body.reasonText,
      );
      return reply.send({ data: ride });
    }
    const ride = await this.rideService.lifecycle.cancelRide(
      id,
      'CUSTOMER',
      callerId(req),
      body.reasonCode,
      body.reasonText,
    );
    return reply.send({ data: ride });
  }
  async submitRating(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const body = submitRatingSchema.parse(req.body);
    const ratedBy = callerHasRole(req, 'driver') ? 'DRIVER' : 'CUSTOMER';
    const rating = await this.ratingService.submitRating(
      id,
      ratedBy,
      callerId(req),
      body.rating,
      body.tags,
      body.comment,
    );
    reply.send({ data: rating });
  }
}
